/**
 * Browsing the library (docs/PLAN.md section 7) and managing tags.
 *
 *   GET    /api/videos?houseId=&q=&tagIds=1,2&areaTypeId=&itemId=&houseAreaId=
 *                     &status=all|inbox|sorted&sort=newest|oldest|title&limit=&offset=
 *   GET    /api/catalog?houseId=      area types, items and the tags usable in a house
 *   POST   /api/tags                  {name, kind?, houseId?}
 *   PATCH  /api/tags/:tagId           {name?, kind?}
 *   DELETE /api/tags/:tagId
 *
 * Everyone signed in can browse the shared library. With houseId, members also see that
 * house's private videos and tags. Shared tags are edited by global admins, house tags by
 * the house's owners and editors.
 */
import type { FastifyPluginCallback } from 'fastify';
import type { Kysely } from 'kysely';
import { writeAudit } from '../audit.js';
import { assertCan, type Principal } from '../auth/policy.js';
import type { Database, TagKind } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { requireHouse, requireScope } from '../houses/access.js';
import { searchVideos, type SearchSort } from '../videos/search.js';
import { ID } from './schemas.js';

type Db = Kysely<Database>;

const TAG_KINDS = ['task', 'skill', 'topic', 'trade', 'tools', 'other'] as const;
const TAG_NAME = { type: 'string', minLength: 1, maxLength: 128 } as const;
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

/** "Code & permits" → "code-permits". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function cleanTagName(name: string): { name: string; slug: string } {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  const slug = slugify(cleaned);
  if (!slug) throw new ValidationError('Tag name must contain letters or digits');
  return { name: cleaned, slug };
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === ER_DUP_ENTRY;
}

/** Shared house scope: houseId given → must be visible to the caller. */
async function visibleHouse(
  db: Db,
  principal: Principal,
  houseId: number | undefined,
): Promise<number | null> {
  if (houseId === undefined) return null;
  await requireHouse(db, principal, houseId, 'house.view');
  return houseId;
}

async function requireTag(
  db: Db,
  principal: Principal,
  tagId: number,
): Promise<{ id: number; houseId: number | null; name: string }> {
  const tag = await db
    .selectFrom('tags')
    .select(['id', 'house_id', 'name'])
    .where('id', '=', tagId)
    .executeTakeFirst();
  if (!tag) throw new NotFoundError('Tag');
  if (tag.house_id === null) {
    assertCan(principal, 'library.edit');
  } else {
    await requireHouse(db, principal, tag.house_id, 'house.tags.edit');
  }
  return { id: tag.id, houseId: tag.house_id, name: tag.name };
}

interface VideoQuery {
  houseId?: number;
  q?: string;
  tagIds?: string;
  areaTypeId?: number;
  itemId?: number;
  houseAreaId?: number;
  status: 'all' | 'inbox' | 'sorted';
  sort: SearchSort;
  limit: number;
  offset: number;
}

export const libraryRoutes: FastifyPluginCallback<{ db: Db }> = (app, { db }, done) => {
  app.get<{ Querystring: VideoQuery }>(
    '/api/videos',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            houseId: ID,
            q: { type: 'string', maxLength: 200 },
            tagIds: { type: 'string', pattern: '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,19}$' },
            areaTypeId: ID,
            itemId: ID,
            houseAreaId: ID,
            status: { type: 'string', enum: ['all', 'inbox', 'sorted'], default: 'all' },
            sort: { type: 'string', enum: ['newest', 'oldest', 'title'], default: 'newest' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
            offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query;
      const houseId = await visibleHouse(db, request.principal, query.houseId);
      const tagIds = query.tagIds ? [...new Set(query.tagIds.split(',').map(Number))] : [];
      return searchVideos(db, {
        houseId,
        tagIds,
        status: query.status,
        sort: query.sort,
        limit: query.limit,
        offset: query.offset,
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.areaTypeId === undefined ? {} : { areaTypeId: query.areaTypeId }),
        ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
        ...(query.houseAreaId === undefined ? {} : { houseAreaId: query.houseAreaId }),
      });
    },
  );

  app.get<{ Querystring: { houseId?: number } }>(
    '/api/catalog',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { houseId: ID },
        },
      },
    },
    async (request) => {
      const houseId = await visibleHouse(db, request.principal, request.query.houseId);
      const [areaTypes, items, tags] = await Promise.all([
        db
          .selectFrom('area_types')
          .select(['id', 'slug', 'name', 'category', 'default_zone'])
          .orderBy('sort_order')
          .orderBy('id')
          .execute(),
        db
          .selectFrom('items as i')
          .leftJoin('area_types as s', 's.id', 'i.system_area_type_id')
          .select(['i.id', 'i.slug', 'i.name', 's.slug as system', 'i.whole_house'])
          .orderBy('i.sort_order')
          .orderBy('i.id')
          .execute(),
        db
          .selectFrom('tags')
          .select(['id', 'slug', 'name', 'kind', 'house_id'])
          .where((eb) =>
            houseId === null
              ? eb('house_id', 'is', null)
              : eb.or([eb('house_id', 'is', null), eb('house_id', '=', houseId)]),
          )
          .orderBy('kind')
          .orderBy('name')
          .execute(),
      ]);
      return {
        areaTypes: areaTypes.map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          category: a.category,
          zone: a.default_zone,
        })),
        items: items.map((i) => ({
          id: i.id,
          slug: i.slug,
          name: i.name,
          system: i.system,
          wholeHouse: i.whole_house === 1,
        })),
        tags: tags.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          kind: t.kind,
          houseId: t.house_id,
        })),
      };
    },
  );

  app.post<{ Body: { name: string; kind?: TagKind; houseId?: number } }>(
    '/api/tags',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: TAG_NAME,
            kind: { type: 'string', enum: TAG_KINDS },
            houseId: ID,
          },
        },
      },
    },
    async (request, reply) => {
      const houseId = await requireScope(
        db,
        request.principal,
        request.body.houseId,
        'house.tags.edit',
      );
      const { name, slug } = cleanTagName(request.body.name);
      const kind = request.body.kind ?? 'other';
      try {
        const id = await db.transaction().execute(async (trx) => {
          const result = await trx
            .insertInto('tags')
            .values({ house_id: houseId, slug, name, kind })
            .executeTakeFirstOrThrow();
          const tagId = Number(result.insertId);
          await writeAudit(trx, {
            actorEmail: request.principal.email,
            houseId,
            action: 'tag.create',
            entity: 'tag',
            entityId: tagId,
            details: { name, kind },
          });
          return tagId;
        });
        return reply.code(201).send({ id, slug });
      } catch (error) {
        if (isDuplicate(error)) throw new ConflictError('A tag with that name already exists');
        throw error;
      }
    },
  );

  app.patch<{ Params: { tagId: number }; Body: { name?: string; kind?: TagKind } }>(
    '/api/tags/:tagId',
    {
      schema: {
        params: { type: 'object', required: ['tagId'], properties: { tagId: ID } },
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { name: TAG_NAME, kind: { type: 'string', enum: TAG_KINDS } },
        },
      },
    },
    async (request, reply) => {
      const tag = await requireTag(db, request.principal, request.params.tagId);
      const changes: { name?: string; slug?: string; kind?: TagKind } = {};
      if (request.body.name !== undefined) Object.assign(changes, cleanTagName(request.body.name));
      if (request.body.kind !== undefined) changes.kind = request.body.kind;
      try {
        await db.transaction().execute(async (trx) => {
          await trx.updateTable('tags').set(changes).where('id', '=', tag.id).execute();
          await writeAudit(trx, {
            actorEmail: request.principal.email,
            houseId: tag.houseId,
            action: 'tag.update',
            entity: 'tag',
            entityId: tag.id,
            details: changes,
          });
        });
      } catch (error) {
        if (isDuplicate(error)) throw new ConflictError('A tag with that name already exists');
        throw error;
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { tagId: number } }>(
    '/api/tags/:tagId',
    { schema: { params: { type: 'object', required: ['tagId'], properties: { tagId: ID } } } },
    async (request, reply) => {
      const tag = await requireTag(db, request.principal, request.params.tagId);
      await db.transaction().execute(async (trx) => {
        // Video links and keyword rules that use the tag go with it (ON DELETE CASCADE).
        await trx.deleteFrom('tags').where('id', '=', tag.id).execute();
        await writeAudit(trx, {
          actorEmail: request.principal.email,
          houseId: tag.houseId,
          action: 'tag.delete',
          entity: 'tag',
          entityId: tag.id,
          details: { name: tag.name },
        });
      });
      return reply.code(204).send();
    },
  );

  done();
};
