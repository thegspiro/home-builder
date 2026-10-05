/**
 * Keyword rules (global admins). A rule maps a phrase found in a video title to exactly
 * one shared tag, area type or item, which is suggested in the inbox.
 *
 *   GET    /api/keyword-rules
 *   POST   /api/keyword-rules            {phrase, tagId | areaTypeId | itemId, enabled?}
 *   PATCH  /api/keyword-rules/:ruleId    {phrase?, enabled?}
 *   DELETE /api/keyword-rules/:ruleId
 *   POST   /api/keyword-rules/apply      re-run all rules over the inbox
 */
import type { FastifyPluginCallback } from 'fastify';
import type { Kysely } from 'kysely';
import { writeAudit } from '../audit.js';
import { assertCan } from '../auth/policy.js';
import type { Database } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { enqueueJob, findActiveJob } from '../jobs/service.js';
import { ID } from './schemas.js';

const PHRASE = { type: 'string', minLength: 1, maxLength: 200 } as const;
const ruleParams = {
  type: 'object',
  required: ['ruleId'],
  properties: { ruleId: ID },
} as const;

type TargetKind = 'tag' | 'areaType' | 'item';

interface RuleView {
  id: number;
  phrase: string;
  enabled: boolean;
  target: { kind: TargetKind; id: number; name: string };
}

/** A phrase must contain at least one letter or digit to ever match anything. */
function cleanPhrase(phrase: string): string {
  const cleaned = phrase.trim().replace(/\s+/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(cleaned)) {
    throw new ValidationError('phrase must contain letters or digits');
  }
  return cleaned;
}

export const ruleRoutes: FastifyPluginCallback<{ db: Kysely<Database> }> = (app, { db }, done) => {
  app.get('/api/keyword-rules', async (request) => {
    assertCan(request.principal, 'library.edit');
    const rows = await db
      .selectFrom('keyword_rules as r')
      .leftJoin('tags as t', 't.id', 'r.tag_id')
      .leftJoin('area_types as a', 'a.id', 'r.area_type_id')
      .leftJoin('items as i', 'i.id', 'r.item_id')
      .select([
        'r.id',
        'r.phrase',
        'r.enabled',
        'r.tag_id',
        'r.area_type_id',
        'r.item_id',
        't.name as tag_name',
        'a.name as area_name',
        'i.name as item_name',
      ])
      .orderBy('r.phrase')
      .orderBy('r.id')
      .execute();
    const rules: RuleView[] = [];
    for (const r of rows) {
      const target =
        r.tag_id !== null
          ? { kind: 'tag' as const, id: r.tag_id, name: r.tag_name ?? '' }
          : r.area_type_id !== null
            ? { kind: 'areaType' as const, id: r.area_type_id, name: r.area_name ?? '' }
            : r.item_id !== null
              ? { kind: 'item' as const, id: r.item_id, name: r.item_name ?? '' }
              : null;
      if (target) rules.push({ id: r.id, phrase: r.phrase, enabled: r.enabled === 1, target });
    }
    return { rules };
  });

  app.post<{
    Body: {
      phrase: string;
      tagId?: number;
      areaTypeId?: number;
      itemId?: number;
      enabled?: boolean;
    };
  }>(
    '/api/keyword-rules',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phrase'],
          additionalProperties: false,
          properties: {
            phrase: PHRASE,
            tagId: ID,
            areaTypeId: ID,
            itemId: ID,
            enabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      assertCan(request.principal, 'library.edit');
      const { tagId, areaTypeId, itemId } = request.body;
      const targets = [tagId, areaTypeId, itemId].filter((t) => t !== undefined);
      if (targets.length !== 1) {
        throw new ValidationError('Give exactly one of tagId, areaTypeId or itemId');
      }
      const phrase = cleanPhrase(request.body.phrase);

      if (tagId !== undefined) {
        const tag = await db
          .selectFrom('tags')
          .select('id')
          .where('id', '=', tagId)
          .where('house_id', 'is', null)
          .executeTakeFirst();
        if (!tag) throw new ValidationError('Rules can only target shared tags');
      } else if (areaTypeId !== undefined) {
        const area = await db
          .selectFrom('area_types')
          .select('id')
          .where('id', '=', areaTypeId)
          .executeTakeFirst();
        if (!area) throw new ValidationError('Unknown area type');
      } else if (itemId !== undefined) {
        const item = await db
          .selectFrom('items')
          .select('id')
          .where('id', '=', itemId)
          .executeTakeFirst();
        if (!item) throw new ValidationError('Unknown item');
      }

      const id = await db.transaction().execute(async (trx) => {
        const result = await trx
          .insertInto('keyword_rules')
          .values({
            phrase,
            tag_id: tagId ?? null,
            area_type_id: areaTypeId ?? null,
            item_id: itemId ?? null,
            enabled: request.body.enabled ?? true,
          })
          .executeTakeFirstOrThrow();
        const ruleId = Number(result.insertId);
        await writeAudit(trx, {
          actorEmail: request.principal.email,
          houseId: null,
          action: 'rule.create',
          entity: 'keyword_rule',
          entityId: ruleId,
          details: { phrase, tagId, areaTypeId, itemId },
        });
        return ruleId;
      });
      return reply.code(201).send({ id });
    },
  );

  app.patch<{ Params: { ruleId: number }; Body: { phrase?: string; enabled?: boolean } }>(
    '/api/keyword-rules/:ruleId',
    {
      schema: {
        params: ruleParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { phrase: PHRASE, enabled: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      assertCan(request.principal, 'library.edit');
      const changes: { phrase?: string; enabled?: boolean } = {};
      if (request.body.phrase !== undefined) changes.phrase = cleanPhrase(request.body.phrase);
      if (request.body.enabled !== undefined) changes.enabled = request.body.enabled;
      await db.transaction().execute(async (trx) => {
        const rule = await trx
          .selectFrom('keyword_rules')
          .select('id')
          .where('id', '=', request.params.ruleId)
          .forUpdate()
          .executeTakeFirst();
        if (!rule) throw new NotFoundError('Rule');
        await trx
          .updateTable('keyword_rules')
          .set(changes)
          .where('id', '=', request.params.ruleId)
          .execute();
        await writeAudit(trx, {
          actorEmail: request.principal.email,
          houseId: null,
          action: 'rule.update',
          entity: 'keyword_rule',
          entityId: request.params.ruleId,
          details: changes,
        });
      });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { ruleId: number } }>(
    '/api/keyword-rules/:ruleId',
    { schema: { params: ruleParams } },
    async (request, reply) => {
      assertCan(request.principal, 'library.edit');
      await db.transaction().execute(async (trx) => {
        const result = await trx
          .deleteFrom('keyword_rules')
          .where('id', '=', request.params.ruleId)
          .executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) throw new NotFoundError('Rule');
        await writeAudit(trx, {
          actorEmail: request.principal.email,
          houseId: null,
          action: 'rule.delete',
          entity: 'keyword_rule',
          entityId: request.params.ruleId,
        });
      });
      return reply.code(204).send();
    },
  );

  app.post('/api/keyword-rules/apply', async (request, reply) => {
    assertCan(request.principal, 'library.edit');
    const active = await findActiveJob(db, 'apply_rules');
    if (active !== null) return reply.code(202).send({ jobId: active, alreadyQueued: true });
    const jobId = await enqueueJob(db, request.principal, null, {
      type: 'apply_rules',
      payload: {},
    });
    return reply.code(202).send({ jobId, alreadyQueued: false });
  });

  done();
};
