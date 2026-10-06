/**
 * Inbox and classification.
 *
 *   GET    /api/inbox?houseId=&limit=&offset=      videos waiting for review, with suggestions
 *   PUT    /api/videos/:videoId/classification     confirm tags/areas/items; marks it sorted
 *   DELETE /api/videos/:videoId                    remove a video
 *
 * Shared videos (no houseId) are managed by global admins; a house's private videos by
 * its owners and editors. Someone who can't see a private video gets 404.
 */
import type { FastifyPluginCallback } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { writeAudit } from '../audit.js';
import { assertCan, type Principal } from '../auth/policy.js';
import type { Database, MetadataStatus, VideoSource } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { requireHouse, requireScope } from '../houses/access.js';
import { ID, ID_LIST } from './schemas.js';

type Db = Kysely<Database>;

interface Link {
  id: number;
  name: string;
  suggested: boolean;
}

export interface InboxVideo {
  id: number;
  youtubeId: string;
  houseId: number | null;
  title: string | null;
  channelName: string | null;
  thumbnailUrl: string | null;
  source: VideoSource;
  metadataStatus: MetadataStatus;
  createdAt: Date;
  tags: Link[];
  areaTypes: Link[];
  items: Link[];
  houseAreas: { id: number; name: string }[];
}

function groupBy<T extends { video_id: number }>(rows: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const list = map.get(row.video_id) ?? [];
    list.push(row);
    map.set(row.video_id, list);
  }
  return map;
}

async function loadInbox(
  db: Db,
  houseId: number | null,
  limit: number,
  offset: number,
): Promise<{ total: number; videos: InboxVideo[] }> {
  const scoped = db
    .selectFrom('videos')
    .where('review_status', '=', 'inbox')
    .where('house_id', houseId === null ? 'is' : '=', houseId);
  const totalRow = await scoped.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
  const videos = await scoped
    .select([
      'id',
      'youtube_id',
      'house_id',
      'title',
      'channel_name',
      'thumbnail_url',
      'source',
      'metadata_status',
      'created_at',
    ])
    .orderBy('id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();
  const ids = videos.map((v) => v.id);
  if (ids.length === 0) return { total: Number(totalRow?.n ?? 0), videos: [] };

  const [tags, areas, items, houseAreas] = await Promise.all([
    db
      .selectFrom('video_tags as vt')
      .innerJoin('tags as t', 't.id', 'vt.tag_id')
      .select(['vt.video_id', 't.id', 't.name', 'vt.suggested'])
      .where('vt.video_id', 'in', ids)
      .orderBy('t.name')
      .execute(),
    db
      .selectFrom('video_area_types as va')
      .innerJoin('area_types as a', 'a.id', 'va.area_type_id')
      .select(['va.video_id', 'a.id', 'a.name', 'va.suggested'])
      .where('va.video_id', 'in', ids)
      .orderBy('a.sort_order')
      .execute(),
    db
      .selectFrom('video_items as vi')
      .innerJoin('items as i', 'i.id', 'vi.item_id')
      .select(['vi.video_id', 'i.id', 'i.name', 'vi.suggested'])
      .where('vi.video_id', 'in', ids)
      .orderBy('i.sort_order')
      .execute(),
    db
      .selectFrom('video_house_areas as vh')
      .innerJoin('house_areas as h', 'h.id', 'vh.house_area_id')
      .select(['vh.video_id', 'h.id', 'h.name'])
      .where('vh.video_id', 'in', ids)
      .orderBy('h.sort_order')
      .execute(),
  ]);
  const toLinks = (rows: { id: number; name: string; suggested: number }[] = []): Link[] =>
    rows.map((r) => ({ id: r.id, name: r.name, suggested: r.suggested === 1 }));
  const tagMap = groupBy(tags);
  const areaMap = groupBy(areas);
  const itemMap = groupBy(items);
  const houseAreaMap = groupBy(houseAreas);

  return {
    total: Number(totalRow?.n ?? 0),
    videos: videos.map((v) => ({
      id: v.id,
      youtubeId: v.youtube_id,
      houseId: v.house_id,
      title: v.title,
      channelName: v.channel_name,
      thumbnailUrl: v.thumbnail_url,
      source: v.source,
      metadataStatus: v.metadata_status,
      createdAt: v.created_at,
      tags: toLinks(tagMap.get(v.id)),
      areaTypes: toLinks(areaMap.get(v.id)),
      items: toLinks(itemMap.get(v.id)),
      houseAreas: (houseAreaMap.get(v.id) ?? []).map((h) => ({ id: h.id, name: h.name })),
    })),
  };
}

/** Loads a video and checks the caller may edit it. */
async function requireVideo(
  db: Db,
  principal: Principal,
  videoId: number,
): Promise<{ id: number; houseId: number | null; youtubeId: string }> {
  const video = await db
    .selectFrom('videos')
    .select(['id', 'house_id', 'youtube_id'])
    .where('id', '=', videoId)
    .executeTakeFirst();
  if (!video) throw new NotFoundError('Video');
  if (video.house_id === null) {
    assertCan(principal, 'library.edit');
  } else {
    await requireHouse(db, principal, video.house_id, 'house.videos.edit');
  }
  return { id: video.id, houseId: video.house_id, youtubeId: video.youtube_id };
}

function assertAllExist(found: { id: number }[], wanted: readonly number[], message: string): void {
  if (found.length !== new Set(wanted).size) throw new ValidationError(message);
}

interface ClassificationBody {
  tagIds: number[];
  areaTypeIds: number[];
  itemIds: number[];
  houseAreaIds?: number[];
  sorted?: boolean;
}

async function validateClassification(
  trx: Transaction<Database>,
  houseId: number | null,
  body: ClassificationBody,
): Promise<void> {
  if (body.tagIds.length > 0) {
    const tags = await trx
      .selectFrom('tags')
      .select('id')
      .where('id', 'in', body.tagIds)
      .where((eb) =>
        houseId === null
          ? eb('house_id', 'is', null)
          : eb.or([eb('house_id', 'is', null), eb('house_id', '=', houseId)]),
      )
      .execute();
    assertAllExist(tags, body.tagIds, 'Unknown tag, or a tag from another house');
  }
  if (body.areaTypeIds.length > 0) {
    const areas = await trx
      .selectFrom('area_types')
      .select('id')
      .where('id', 'in', body.areaTypeIds)
      .execute();
    assertAllExist(areas, body.areaTypeIds, 'Unknown area type');
  }
  if (body.itemIds.length > 0) {
    const items = await trx
      .selectFrom('items')
      .select('id')
      .where('id', 'in', body.itemIds)
      .execute();
    assertAllExist(items, body.itemIds, 'Unknown item');
  }
  const houseAreaIds = body.houseAreaIds ?? [];
  if (houseAreaIds.length > 0) {
    if (houseId === null) {
      throw new ValidationError('Only a house’s private videos can be linked to its areas');
    }
    const areas = await trx
      .selectFrom('house_areas')
      .select('id')
      .where('id', 'in', houseAreaIds)
      .where('house_id', '=', houseId)
      .execute();
    assertAllExist(areas, houseAreaIds, 'Every area must belong to the video’s house');
  }
}

export const videoRoutes: FastifyPluginCallback<{ db: Db }> = (app, { db }, done) => {
  app.get<{ Querystring: { houseId?: number; limit: number; offset: number } }>(
    '/api/inbox',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            houseId: ID,
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const houseId = await requireScope(
        db,
        request.principal,
        request.query.houseId,
        'house.videos.edit',
      );
      return loadInbox(db, houseId, limit, offset);
    },
  );

  app.put<{ Params: { videoId: number }; Body: ClassificationBody }>(
    '/api/videos/:videoId/classification',
    {
      schema: {
        params: { type: 'object', required: ['videoId'], properties: { videoId: ID } },
        body: {
          type: 'object',
          required: ['tagIds', 'areaTypeIds', 'itemIds'],
          additionalProperties: false,
          properties: {
            tagIds: ID_LIST,
            areaTypeIds: ID_LIST,
            itemIds: ID_LIST,
            houseAreaIds: ID_LIST,
            sorted: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (request, reply) => {
      const video = await requireVideo(db, request.principal, request.params.videoId);
      const body = request.body;
      await db.transaction().execute(async (trx) => {
        await validateClassification(trx, video.houseId, body);
        const id = video.id;
        await trx.deleteFrom('video_tags').where('video_id', '=', id).execute();
        await trx.deleteFrom('video_area_types').where('video_id', '=', id).execute();
        await trx.deleteFrom('video_items').where('video_id', '=', id).execute();
        await trx.deleteFrom('video_house_areas').where('video_id', '=', id).execute();
        if (body.tagIds.length > 0) {
          await trx
            .insertInto('video_tags')
            .values(body.tagIds.map((tag_id) => ({ video_id: id, tag_id, suggested: false })))
            .execute();
        }
        if (body.areaTypeIds.length > 0) {
          await trx
            .insertInto('video_area_types')
            .values(
              body.areaTypeIds.map((area_type_id) => ({
                video_id: id,
                area_type_id,
                suggested: false,
              })),
            )
            .execute();
        }
        if (body.itemIds.length > 0) {
          await trx
            .insertInto('video_items')
            .values(body.itemIds.map((item_id) => ({ video_id: id, item_id, suggested: false })))
            .execute();
        }
        const houseAreaIds = body.houseAreaIds ?? [];
        if (houseAreaIds.length > 0) {
          await trx
            .insertInto('video_house_areas')
            .values(houseAreaIds.map((house_area_id) => ({ video_id: id, house_area_id })))
            .execute();
        }
        await trx
          .updateTable('videos')
          .set({ review_status: body.sorted === false ? 'inbox' : 'sorted' })
          .where('id', '=', id)
          .execute();
        await writeAudit(trx, {
          actorEmail: request.principal.email,
          houseId: video.houseId,
          action: 'video.classify',
          entity: 'video',
          entityId: id,
          details: { ...body },
        });
      });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { videoId: number } }>(
    '/api/videos/:videoId',
    { schema: { params: { type: 'object', required: ['videoId'], properties: { videoId: ID } } } },
    async (request, reply) => {
      const video = await requireVideo(db, request.principal, request.params.videoId);
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('videos').where('id', '=', video.id).execute();
        await writeAudit(trx, {
          actorEmail: request.principal.email,
          houseId: video.houseId,
          action: 'video.delete',
          entity: 'video',
          entityId: video.id,
          details: { youtubeId: video.youtubeId },
        });
      });
      return reply.code(204).send();
    },
  );

  done();
};
