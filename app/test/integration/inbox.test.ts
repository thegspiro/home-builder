import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/schema.js';
import type { InboxVideo } from '../../src/routes/videos.js';
import { ADMIN, createClient, type Client } from './app-client.js';
import { createTestDb, resetDatabase } from './db.js';

const OWNER = 'owner@example.com';
const EDITOR = 'editor@example.com';
const VIEWER = 'viewer@example.com';
const OTHER = 'other@example.com';

describe('inbox and classification', () => {
  let db: Kysely<Database>;
  let client: Client;
  let houseId: number;
  let otherHouseId: number;
  let ids: { repair: number; install: number; garage: number; kitchen: number; panel: number };

  beforeAll(async () => {
    db = createTestDb();
    await resetDatabase(db);
    await migrateToLatest(db);
    client = await createClient(db);
    const one = async (table: 'tags' | 'area_types' | 'items', slug: string) =>
      (await db.selectFrom(table).select('id').where('slug', '=', slug).executeTakeFirstOrThrow())
        .id;
    ids = {
      repair: await one('tags', 'repair'),
      install: await one('tags', 'install'),
      garage: await one('area_types', 'garage'),
      kitchen: await one('area_types', 'kitchen'),
      panel: await one('items', 'electrical-panel'),
    };
  });

  afterAll(async () => {
    await client?.close();
    await db?.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom('videos').execute();
    await db.deleteFrom('tags').where('house_id', 'is not', null).execute();
    await db.deleteFrom('houses').execute();
    houseId = (
      await client.as(ADMIN)('POST', '/api/houses', { name: 'Home', ownerEmail: OWNER })
    ).json<{ id: number }>().id;
    otherHouseId = (
      await client.as(ADMIN)('POST', '/api/houses', { name: 'Other', ownerEmail: OTHER })
    ).json<{ id: number }>().id;
    await client.as(OWNER)('PUT', `/api/houses/${houseId}/members/${EDITOR}`, { role: 'editor' });
    await client.as(OWNER)('PUT', `/api/houses/${houseId}/members/${VIEWER}`, { role: 'viewer' });
  });

  async function addVideo(youtubeId: string, house: number | null, title = `Video ${youtubeId}`) {
    const result = await db
      .insertInto('videos')
      .values({
        youtube_id: youtubeId,
        house_id: house,
        title,
        source: 'paste',
        added_by: 'x@example.com',
        metadata_status: 'ok',
      })
      .executeTakeFirstOrThrow();
    return Number(result.insertId);
  }

  async function inbox(as: string, house?: number) {
    const res = await client.as(as)('GET', `/api/inbox${house ? `?houseId=${house}` : ''}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ total: number; videos: InboxVideo[] }>();
  }

  it('lists shared inbox videos with their suggestions, newest first', async () => {
    const older = await addVideo('aaaaaaaaaaa', null, 'Fix a garage door');
    const newer = await addVideo('bbbbbbbbbbb', null);
    await addVideo('ccccccccccc', houseId);
    await db
      .insertInto('video_tags')
      .values({ video_id: older, tag_id: ids.repair, suggested: true })
      .execute();
    await db
      .insertInto('video_area_types')
      .values({ video_id: older, area_type_id: ids.garage, suggested: true })
      .execute();

    const { total, videos } = await inbox(ADMIN);
    expect(total).toBe(2);
    expect(videos.map((v) => v.id)).toEqual([newer, older]);
    expect(videos[1]).toMatchObject({
      youtubeId: 'aaaaaaaaaaa',
      houseId: null,
      title: 'Fix a garage door',
      tags: [{ id: ids.repair, name: 'Repair', suggested: true }],
      areaTypes: [{ id: ids.garage, name: 'Garage', suggested: true }],
      items: [],
      houseAreas: [],
    });
  });

  it('pages through the inbox', async () => {
    for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']) await addVideo(id, null);
    const res = await client.as(ADMIN)('GET', '/api/inbox?limit=2&offset=2');
    expect(res.json<{ total: number; videos: InboxVideo[] }>()).toMatchObject({ total: 3 });
    expect(res.json<{ videos: InboxVideo[] }>().videos.map((v) => v.youtubeId)).toEqual([
      'aaaaaaaaaaa',
    ]);
    expect((await client.as(ADMIN)('GET', '/api/inbox?limit=201')).statusCode).toBe(400);
  });

  it('scopes house inboxes to editors of that house', async () => {
    await addVideo('aaaaaaaaaaa', houseId);
    await addVideo('bbbbbbbbbbb', otherHouseId);
    expect((await inbox(EDITOR, houseId)).videos.map((v) => v.youtubeId)).toEqual(['aaaaaaaaaaa']);
    expect((await client.as(VIEWER)('GET', `/api/inbox?houseId=${houseId}`)).statusCode).toBe(403);
    expect((await client.as(OTHER)('GET', `/api/inbox?houseId=${houseId}`)).statusCode).toBe(404);
    expect((await client.as(EDITOR)('GET', '/api/inbox')).statusCode).toBe(403);
  });

  it('confirms a classification, replacing suggestions, and marks the video sorted', async () => {
    const video = await addVideo('aaaaaaaaaaa', null);
    await db
      .insertInto('video_tags')
      .values({ video_id: video, tag_id: ids.repair, suggested: true })
      .execute();
    await db
      .insertInto('video_area_types')
      .values({ video_id: video, area_type_id: ids.kitchen, suggested: true })
      .execute();

    const res = await client.as(ADMIN)('PUT', `/api/videos/${video}/classification`, {
      tagIds: [ids.install],
      areaTypeIds: [ids.garage],
      itemIds: [ids.panel],
    });
    expect(res.statusCode, res.body).toBe(204);

    const tags = await db
      .selectFrom('video_tags')
      .select(['tag_id', 'suggested'])
      .where('video_id', '=', video)
      .execute();
    expect(tags).toEqual([{ tag_id: ids.install, suggested: 0 }]);
    const areas = await db
      .selectFrom('video_area_types')
      .select(['area_type_id', 'suggested'])
      .where('video_id', '=', video)
      .execute();
    expect(areas).toEqual([{ area_type_id: ids.garage, suggested: 0 }]);
    const row = await db
      .selectFrom('videos')
      .select('review_status')
      .where('id', '=', video)
      .executeTakeFirstOrThrow();
    expect(row.review_status).toBe('sorted');
    expect((await inbox(ADMIN)).total).toBe(0);

    const audit = await db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', String(video))
      .execute();
    expect(audit.map((a) => a.action)).toContain('video.classify');
  });

  it('can save without leaving the inbox', async () => {
    const video = await addVideo('aaaaaaaaaaa', null);
    await client.as(ADMIN)('PUT', `/api/videos/${video}/classification`, {
      tagIds: [ids.repair],
      areaTypeIds: [],
      itemIds: [],
      sorted: false,
    });
    expect((await inbox(ADMIN)).videos[0]?.tags).toEqual([
      { id: ids.repair, name: 'Repair', suggested: false },
    ]);
  });

  it('lets a house editor classify a private video with house tags and house areas', async () => {
    const video = await addVideo('aaaaaaaaaaa', houseId);
    await db
      .insertInto('tags')
      .values({ house_id: houseId, slug: 'our-reno', name: 'Our reno' })
      .execute();
    const houseTag = await db
      .selectFrom('tags')
      .select('id')
      .where('slug', '=', 'our-reno')
      .executeTakeFirstOrThrow();
    const area = await db
      .selectFrom('house_areas')
      .select('id')
      .where('house_id', '=', houseId)
      .executeTakeFirstOrThrow();

    const res = await client.as(EDITOR)('PUT', `/api/videos/${video}/classification`, {
      tagIds: [houseTag.id, ids.repair],
      areaTypeIds: [],
      itemIds: [],
      houseAreaIds: [area.id],
    });
    expect(res.statusCode, res.body).toBe(204);
    const links = await db
      .selectFrom('video_house_areas')
      .select('house_area_id')
      .where('video_id', '=', video)
      .execute();
    expect(links).toEqual([{ house_area_id: area.id }]);
  });

  it('rejects links that cross scopes or do not exist, changing nothing', async () => {
    const shared = await addVideo('aaaaaaaaaaa', null);
    const mine = await addVideo('bbbbbbbbbbb', houseId);
    await db
      .insertInto('tags')
      .values({ house_id: otherHouseId, slug: 'theirs', name: 'Theirs' })
      .execute();
    const theirTag = await db
      .selectFrom('tags')
      .select('id')
      .where('slug', '=', 'theirs')
      .executeTakeFirstOrThrow();
    const theirArea = await db
      .selectFrom('house_areas')
      .select('id')
      .where('house_id', '=', otherHouseId)
      .executeTakeFirstOrThrow();
    const myArea = await db
      .selectFrom('house_areas')
      .select('id')
      .where('house_id', '=', houseId)
      .executeTakeFirstOrThrow();
    const empty = { tagIds: [], areaTypeIds: [], itemIds: [] };

    const cases: [number, object][] = [
      [mine, { ...empty, tagIds: [theirTag.id] }],
      [mine, { ...empty, houseAreaIds: [theirArea.id] }],
      [shared, { ...empty, houseAreaIds: [myArea.id] }],
      [shared, { ...empty, tagIds: [999999] }],
      [shared, { ...empty, areaTypeIds: [999999] }],
      [shared, { ...empty, itemIds: [999999] }],
      [shared, { tagIds: [ids.repair] }],
    ];
    for (const [video, body] of cases) {
      const as = video === shared ? ADMIN : OWNER;
      const res = await client.as(as)('PUT', `/api/videos/${video}/classification`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const statuses = await db.selectFrom('videos').select('review_status').execute();
    expect(statuses.every((s) => s.review_status === 'inbox')).toBe(true);
  });

  it('enforces who may classify or delete which video', async () => {
    const shared = await addVideo('aaaaaaaaaaa', null);
    const mine = await addVideo('bbbbbbbbbbb', houseId);
    const body = { tagIds: [], areaTypeIds: [], itemIds: [] };

    expect(
      (await client.as(OWNER)('PUT', `/api/videos/${shared}/classification`, body)).statusCode,
    ).toBe(403);
    expect(
      (await client.as(VIEWER)('PUT', `/api/videos/${mine}/classification`, body)).statusCode,
    ).toBe(403);
    expect(
      (await client.as(OTHER)('PUT', `/api/videos/${mine}/classification`, body)).statusCode,
    ).toBe(404);
    expect((await client.as(OTHER)('DELETE', `/api/videos/${mine}`)).statusCode).toBe(404);
    expect(
      (await client.as(ADMIN)('PUT', '/api/videos/999999/classification', body)).statusCode,
    ).toBe(404);

    expect((await client.as(EDITOR)('DELETE', `/api/videos/${mine}`)).statusCode).toBe(204);
    expect((await client.as(ADMIN)('DELETE', `/api/videos/${shared}`)).statusCode).toBe(204);
    expect(await db.selectFrom('videos').select('id').execute()).toEqual([]);
  });
});
