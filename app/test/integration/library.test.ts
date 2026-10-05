import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/schema.js';
import type { HouseDetail } from '../../src/houses/service.js';
import type { SearchResult } from '../../src/videos/search.js';
import { ADMIN, createClient, type Client } from './app-client.js';
import { createTestDb, resetDatabase } from './db.js';

const OWNER = 'owner@example.com';
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';

describe('library: search, catalog and tags', () => {
  let db: Kysely<Database>;
  let client: Client;
  let houseId: number;
  let otherHouseId: number;
  let house: HouseDetail;
  const id = {
    tag: {} as Record<string, number>,
    area: {} as Record<string, number>,
    item: {} as Record<string, number>,
  };

  beforeAll(async () => {
    db = createTestDb();
    await resetDatabase(db);
    await migrateToLatest(db);
    client = await createClient(db);
    for (const t of await db
      .selectFrom('tags')
      .select(['id', 'slug'])
      .where('house_id', 'is', null)
      .execute())
      id.tag[t.slug] = t.id;
    for (const a of await db.selectFrom('area_types').select(['id', 'slug']).execute())
      id.area[a.slug] = a.id;
    for (const i of await db.selectFrom('items').select(['id', 'slug']).execute())
      id.item[i.slug] = i.id;
  });

  afterAll(async () => {
    await client?.close();
    await db?.destroy();
  });

  async function video(
    youtubeId: string,
    title: string | null,
    opts: {
      house?: number | null;
      tags?: string[];
      areas?: string[];
      items?: string[];
      status?: 'inbox' | 'sorted';
      channel?: string;
    } = {},
  ): Promise<number> {
    const result = await db
      .insertInto('videos')
      .values({
        youtube_id: youtubeId,
        house_id: opts.house ?? null,
        title,
        channel_name: opts.channel ?? null,
        source: 'manual',
        added_by: ADMIN,
        metadata_status: title ? 'ok' : 'pending',
        review_status: opts.status ?? 'sorted',
      })
      .executeTakeFirstOrThrow();
    const videoId = Number(result.insertId);
    for (const t of opts.tags ?? [])
      await db.insertInto('video_tags').values({ video_id: videoId, tag_id: id.tag[t]! }).execute();
    for (const a of opts.areas ?? [])
      await db
        .insertInto('video_area_types')
        .values({ video_id: videoId, area_type_id: id.area[a]! })
        .execute();
    for (const i of opts.items ?? [])
      await db
        .insertInto('video_items')
        .values({ video_id: videoId, item_id: id.item[i]! })
        .execute();
    return videoId;
  }

  async function search(as: string, query: string): Promise<SearchResult> {
    const res = await client.as(as)('GET', `/api/videos?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SearchResult>();
  }
  const titles = (r: SearchResult) => r.videos.map((v) => v.title);

  beforeEach(async () => {
    await db.deleteFrom('videos').execute();
    await db.deleteFrom('tags').where('house_id', 'is not', null).execute();
    await db.deleteFrom('houses').execute();
    houseId = (
      await client.as(ADMIN)('POST', '/api/houses', { name: 'Home', ownerEmail: OWNER })
    ).json<{ id: number }>().id;
    otherHouseId = (
      await client.as(ADMIN)('POST', '/api/houses', { name: 'Other', ownerEmail: STRANGER })
    ).json<{ id: number }>().id;
    await client.as(OWNER)('PUT', `/api/houses/${houseId}/members/${VIEWER}`, { role: 'viewer' });
    house = (await client.as(OWNER)('GET', `/api/houses/${houseId}`)).json<HouseDetail>();
  });

  const areaId = (slug: string) => house.areas.find((a) => a.areaTypeSlug === slug)!.id;

  describe('GET /api/videos', () => {
    it('searches titles and channels with every word required, prefix matching', async () => {
      await video('aaaaaaaaaaa', 'Insulating a garage door', { channel: 'DIY Dan' });
      await video('bbbbbbbbbbb', 'Garage floor epoxy');
      await video('ccccccccccc', 'Fixing a leaky faucet', { channel: 'Garage Plumbing' });

      expect(titles(await search(VIEWER, 'q=garage'))).toEqual([
        'Fixing a leaky faucet',
        'Garage floor epoxy',
        'Insulating a garage door',
      ]);
      expect(titles(await search(VIEWER, 'q=garage%20door'))).toEqual(['Insulating a garage door']);
      expect(titles(await search(VIEWER, 'q=insul'))).toEqual(['Insulating a garage door']);
      expect(titles(await search(VIEWER, 'q=dan'))).toEqual(['Insulating a garage door']);
      // Operators are ignored: "-door" is just another required word, quotes do nothing.
      expect(titles(await search(VIEWER, 'q=%2Bgarage%20%22epoxy'))).toEqual([
        'Garage floor epoxy',
      ]);
      expect(titles(await search(VIEWER, 'q=garage%20-door'))).toEqual([
        'Insulating a garage door',
      ]);
      expect((await search(VIEWER, 'q=nothingmatches')).total).toBe(0);
    });

    it('matches short words like "AC" as whole words', async () => {
      await video('aaaaaaaaaaa', 'Cleaning your AC condenser');
      await video('bbbbbbbbbbb', 'Back porch repair');
      expect(titles(await search(VIEWER, 'q=ac'))).toEqual(['Cleaning your AC condenser']);
    });

    it('shows shared videos to everyone and private ones only to that house', async () => {
      await video('aaaaaaaaaaa', 'Shared video');
      await video('bbbbbbbbbbb', 'Our private video', { house: houseId });
      await video('ccccccccccc', 'Their private video', { house: otherHouseId });

      expect(titles(await search(VIEWER, 'sort=title'))).toEqual(['Shared video']);
      expect(titles(await search(VIEWER, `houseId=${houseId}&sort=title`))).toEqual([
        'Our private video',
        'Shared video',
      ]);
      expect(
        (await client.as(VIEWER)('GET', `/api/videos?houseId=${otherHouseId}`)).statusCode,
      ).toBe(404);
      expect(titles(await search(ADMIN, `houseId=${otherHouseId}&sort=title`))).toEqual([
        'Shared video',
        'Their private video',
      ]);
    });

    it('filters by all given tags, area type, item and review status', async () => {
      await video('aaaaaaaaaaa', 'Install a panel', {
        tags: ['install', 'electrical'],
        items: ['electrical-panel'],
      });
      await video('bbbbbbbbbbb', 'Install a faucet', {
        tags: ['install', 'plumbing'],
        areas: ['kitchen'],
      });
      await video('ccccccccccc', 'Unsorted', { tags: ['install'], status: 'inbox' });

      expect(titles(await search(VIEWER, `tagIds=${id.tag['install']}&sort=title`))).toEqual([
        'Install a faucet',
        'Install a panel',
        'Unsorted',
      ]);
      expect(
        titles(await search(VIEWER, `tagIds=${id.tag['install']},${id.tag['plumbing']}`)),
      ).toEqual(['Install a faucet']);
      expect(titles(await search(VIEWER, `areaTypeId=${id.area['kitchen']}`))).toEqual([
        'Install a faucet',
      ]);
      expect(titles(await search(VIEWER, `itemId=${id.item['electrical-panel']}`))).toEqual([
        'Install a panel',
      ]);
      expect(titles(await search(VIEWER, 'status=inbox'))).toEqual(['Unsorted']);
      expect((await search(VIEWER, 'status=sorted')).total).toBe(2);
    });

    it('finds a room’s videos through its type, placed items, direct links and whole-house items', async () => {
      await video('aaaaaaaaaaa', 'Garage door springs', { areas: ['garage'] });
      await video('bbbbbbbbbbb', 'Panel upgrade', { items: ['electrical-panel'] });
      await video('ccccccccccc', 'Thermostat wiring', { items: ['thermostat'] });
      await video('ddddddddddd', 'Shingle repair', { areas: ['roof-gutters'] });
      const privateId = await video('eeeeeeeeeee', 'Our garage shelves', { house: houseId });
      await db
        .insertInto('video_house_areas')
        .values({ video_id: privateId, house_area_id: areaId('garage') })
        .execute();

      const inGarage = await search(
        VIEWER,
        `houseId=${houseId}&houseAreaId=${areaId('garage')}&sort=title`,
      );
      expect(titles(inGarage)).toEqual([
        'Garage door springs',
        'Our garage shelves',
        'Panel upgrade',
        'Thermostat wiring',
      ]);

      // Move the panel to the basement: its video follows, in this house only.
      const panel = house.items.find((i) => i.slug === 'electrical-panel')!;
      await client.as(OWNER)('PUT', `/api/houses/${houseId}/items/${panel.id}/placements`, {
        areaIds: [areaId('basement')],
      });
      expect(
        titles(
          await search(VIEWER, `houseId=${houseId}&houseAreaId=${areaId('garage')}&sort=title`),
        ),
      ).toEqual(['Garage door springs', 'Our garage shelves', 'Thermostat wiring']);
      expect(
        titles(await search(VIEWER, `houseId=${houseId}&houseAreaId=${areaId('basement')}`)),
      ).toEqual(['Thermostat wiring', 'Panel upgrade']);

      // Exterior areas don't get whole-house items; hidden items disappear.
      expect(
        titles(await search(VIEWER, `houseId=${houseId}&houseAreaId=${areaId('roof-gutters')}`)),
      ).toEqual(['Shingle repair']);
      await client.as(OWNER)(
        'PUT',
        `/api/houses/${houseId}/items/${id.item['thermostat']}/hidden`,
        { hidden: true },
      );
      expect(
        titles(await search(VIEWER, `houseId=${houseId}&houseAreaId=${areaId('basement')}`)),
      ).toEqual(['Panel upgrade']);
    });

    it('rejects an area outside the given house and bad parameters', async () => {
      const other = (
        await client.as(ADMIN)('GET', `/api/houses/${otherHouseId}`)
      ).json<HouseDetail>();
      expect(
        (
          await client.as(OWNER)(
            'GET',
            `/api/videos?houseId=${houseId}&houseAreaId=${other.areas[0]!.id}`,
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (await client.as(OWNER)('GET', `/api/videos?houseAreaId=${areaId('garage')}`)).statusCode,
      ).toBe(400);
      for (const q of [
        'tagIds=1,,2',
        'tagIds=abc',
        'sort=random',
        'limit=101',
        'status=deleted',
        'q=' + 'x'.repeat(201),
      ]) {
        expect((await client.as(OWNER)('GET', `/api/videos?${q}`)).statusCode, q).toBe(400);
      }
    });

    it('sorts and pages, with untitled videos last when sorting by title', async () => {
      await video('aaaaaaaaaaa', 'Beta');
      await video('bbbbbbbbbbb', null);
      await video('ccccccccccc', 'Alpha');
      expect(titles(await search(VIEWER, 'sort=title'))).toEqual(['Alpha', 'Beta', null]);
      expect(titles(await search(VIEWER, 'sort=oldest'))).toEqual(['Beta', null, 'Alpha']);
      const page = await search(VIEWER, 'sort=newest&limit=1&offset=1');
      expect(page.total).toBe(3);
      expect(titles(page)).toEqual([null]);
    });

    it('returns links with each video', async () => {
      await video('aaaaaaaaaaa', 'Install a panel', {
        tags: ['install'],
        items: ['electrical-panel'],
        areas: ['garage'],
      });
      const [v] = (await search(VIEWER, '')).videos;
      expect(v).toMatchObject({
        youtubeId: 'aaaaaaaaaaa',
        reviewStatus: 'sorted',
        tags: [{ id: id.tag['install'], name: 'Install', suggested: false }],
        areaTypes: [{ id: id.area['garage'], name: 'Garage', suggested: false }],
        items: [
          { id: id.item['electrical-panel'], name: 'Electrical panel (main)', suggested: false },
        ],
      });
    });
  });

  describe('GET /api/catalog', () => {
    it('lists area types, items, shared tags and the house’s own tags', async () => {
      await db
        .insertInto('tags')
        .values([
          { house_id: houseId, slug: 'ours', name: 'Ours' },
          { house_id: otherHouseId, slug: 'theirs', name: 'Theirs' },
        ])
        .execute();
      const shared = (await client.as(VIEWER)('GET', '/api/catalog')).json<{
        areaTypes: unknown[];
        items: unknown[];
        tags: { slug: string }[];
      }>();
      expect(shared.areaTypes).toHaveLength(24);
      expect(shared.items).toHaveLength(65);
      expect(shared.tags.map((t) => t.slug)).not.toContain('ours');

      const mine = (await client.as(VIEWER)('GET', `/api/catalog?houseId=${houseId}`)).json<{
        tags: { slug: string; houseId: number | null }[];
      }>();
      expect(mine.tags.filter((t) => t.houseId !== null).map((t) => t.slug)).toEqual(['ours']);
      expect(
        (await client.as(VIEWER)('GET', `/api/catalog?houseId=${otherHouseId}`)).statusCode,
      ).toBe(404);
    });
  });

  describe('tags', () => {
    it('lets admins manage shared tags and house editors manage house tags', async () => {
      const shared = await client.as(ADMIN)('POST', '/api/tags', {
        name: 'Smart home',
        kind: 'topic',
      });
      expect(shared.statusCode, shared.body).toBe(201);
      expect(shared.json()).toMatchObject({ slug: 'smart-home' });
      expect((await client.as(OWNER)('POST', '/api/tags', { name: 'Nope' })).statusCode).toBe(403);

      const ours = await client.as(OWNER)('POST', '/api/tags', {
        name: '  Basement   reno ',
        houseId,
      });
      expect(ours.statusCode, ours.body).toBe(201);
      const oursId = ours.json<{ id: number }>().id;
      const row = await db
        .selectFrom('tags')
        .selectAll()
        .where('id', '=', oursId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        name: 'Basement reno',
        slug: 'basement-reno',
        kind: 'other',
        house_id: houseId,
      });

      expect(
        (await client.as(VIEWER)('POST', '/api/tags', { name: 'x', houseId })).statusCode,
      ).toBe(403);
      expect(
        (await client.as(STRANGER)('PATCH', `/api/tags/${oursId}`, { name: 'Hijack' })).statusCode,
      ).toBe(404);
      expect(
        (
          await client.as(OWNER)('PATCH', `/api/tags/${oursId}`, {
            name: 'Basement redo',
            kind: 'task',
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await client.as(OWNER)('DELETE', `/api/tags/${shared.json<{ id: number }>().id}`))
          .statusCode,
      ).toBe(403);
      expect((await client.as(OWNER)('DELETE', `/api/tags/${oursId}`)).statusCode).toBe(204);
      expect((await client.as(OWNER)('DELETE', `/api/tags/${oursId}`)).statusCode).toBe(404);
      await db.deleteFrom('tags').where('slug', '=', 'smart-home').execute();
    });

    it('rejects duplicates within a scope but allows them across scopes', async () => {
      expect((await client.as(ADMIN)('POST', '/api/tags', { name: 'Repair' })).statusCode).toBe(
        409,
      );
      expect(
        (await client.as(OWNER)('POST', '/api/tags', { name: 'Repair', houseId })).statusCode,
      ).toBe(201);
      expect(
        (await client.as(OWNER)('POST', '/api/tags', { name: 'REPAIR!', houseId })).statusCode,
      ).toBe(409);
      const other = await client.as(OWNER)('POST', '/api/tags', { name: 'Other', houseId });
      expect(
        (
          await client.as(OWNER)('PATCH', `/api/tags/${other.json<{ id: number }>().id}`, {
            name: 'repair',
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await client.as(OWNER)('POST', '/api/tags', { name: '!!!', houseId })).statusCode,
      ).toBe(400);
    });

    it('deleting a tag removes it from videos', async () => {
      const t = (await client.as(OWNER)('POST', '/api/tags', { name: 'Temp', houseId })).json<{
        id: number;
      }>().id;
      const v = await video('aaaaaaaaaaa', 'Private', { house: houseId });
      await db.insertInto('video_tags').values({ video_id: v, tag_id: t }).execute();
      await client.as(OWNER)('DELETE', `/api/tags/${t}`);
      expect(
        await db.selectFrom('video_tags').select('tag_id').where('video_id', '=', v).execute(),
      ).toEqual([]);
    });
  });
});
