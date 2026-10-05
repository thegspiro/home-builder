import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/schema.js';
import { AREA_TYPES, ITEMS } from '../../src/db/seed-data.js';
import type { HouseDetail } from '../../src/houses/service.js';
import { ADMIN, createClient, type Client } from './app-client.js';
import { createTestDb, resetDatabase } from './db.js';

const OWNER = 'owner@example.com';
const EDITOR = 'editor@example.com';
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';
const OTHER_OWNER = 'other-owner@example.com';

const ROOM_TYPES = AREA_TYPES.filter((a) => a.category !== 'system');

describe('houses API', () => {
  let db: Kysely<Database>;
  let client: Client;
  const admin = () => client.as(ADMIN);
  const owner = () => client.as(OWNER);
  const editor = () => client.as(EDITOR);
  const viewer = () => client.as(VIEWER);
  const stranger = () => client.as(STRANGER);
  let houseId: number;
  let otherHouseId: number;

  async function createHouse(name: string, ownerEmail: string): Promise<number> {
    const res = await admin()('POST', '/api/houses', { name, ownerEmail });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: number }>().id;
  }

  async function detail(id: number, as = owner()): Promise<HouseDetail> {
    const res = await as('GET', `/api/houses/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<HouseDetail>();
  }

  function itemBySlug(house: HouseDetail, slug: string) {
    const item = house.items.find((i) => i.slug === slug);
    if (!item) throw new Error(`no item ${slug}`);
    return item;
  }

  function areaByType(house: HouseDetail, slug: string) {
    const area = house.areas.find((a) => a.areaTypeSlug === slug);
    if (!area) throw new Error(`no area ${slug}`);
    return area;
  }

  beforeAll(async () => {
    db = createTestDb();
    await resetDatabase(db);
    await migrateToLatest(db);
    client = await createClient(db);
  });

  afterAll(async () => {
    await client?.close();
    await db?.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom('videos').execute();
    await db.deleteFrom('tags').where('house_id', 'is not', null).execute();
    await db.deleteFrom('houses').execute();
    await db.deleteFrom('audit_log').execute();
    houseId = await createHouse('Main house', OWNER);
    otherHouseId = await createHouse('Other house', OTHER_OWNER);
    for (const [email, role] of [
      [EDITOR, 'editor'],
      [VIEWER, 'viewer'],
    ] as const) {
      const res = await owner()('PUT', `/api/houses/${houseId}/members/${email}`, { role });
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  describe('creating a house', () => {
    it('gives it one area per room type and the default item placements', async () => {
      const house = await detail(houseId);
      expect(house).toMatchObject({ id: houseId, name: 'Main house', role: 'owner' });
      expect(house.areas.map((a) => a.areaTypeSlug)).toEqual(ROOM_TYPES.map((a) => a.slug));
      expect(house.areas.every((a) => a.zone !== 'overlay')).toBe(true);
      expect(house.items).toHaveLength(ITEMS.length);

      const garage = areaByType(house, 'garage');
      const basement = areaByType(house, 'basement');
      expect(itemBySlug(house, 'electrical-panel').areaIds).toEqual([garage.id]);
      expect(itemBySlug(house, 'furnace').areaIds).toEqual([basement.id]);
      expect(itemBySlug(house, 'thermostat')).toMatchObject({ wholeHouse: true, areaIds: [] });
      expect(house.items.every((i) => !i.hidden)).toBe(true);
    });

    it('makes the creator the owner when no owner email is given', async () => {
      const res = await admin()('POST', '/api/houses', { name: 'Admin cabin' });
      const id = res.json<{ id: number }>().id;
      const members = await admin()('GET', `/api/houses/${id}/members`);
      expect(members.json()).toEqual({ members: [{ email: ADMIN, role: 'owner' }] });
    });

    it('normalizes the owner email and trims the name', async () => {
      const res = await admin()('POST', '/api/houses', {
        name: '  Lake house  ',
        ownerEmail: 'Someone@Example.COM',
      });
      const id = res.json<{ id: number }>().id;
      const house = await detail(id, client.as('someone@example.com'));
      expect(house.name).toBe('Lake house');
    });

    it.each([
      [{ name: '' }],
      [{ name: '   ' }],
      [{ name: 'x'.repeat(129) }],
      [{ name: 'ok', ownerEmail: 'not-an-email' }],
      [{}],
    ])('rejects invalid input %j', async (body) => {
      const res = await admin()('POST', '/api/houses', body);
      expect(res.statusCode).toBe(400);
    });

    it('is admin-only', async () => {
      const res = await owner()('POST', '/api/houses', { name: 'Mine' });
      expect(res.statusCode).toBe(403);
    });

    it('is audited', async () => {
      const rows = await db
        .selectFrom('audit_log')
        .select(['actor_email', 'house_id', 'action'])
        .where('action', '=', 'house.create')
        .orderBy('id')
        .execute();
      expect(rows).toEqual([
        { actor_email: ADMIN, house_id: houseId, action: 'house.create' },
        { actor_email: ADMIN, house_id: otherHouseId, action: 'house.create' },
      ]);
    });
  });

  describe('visibility', () => {
    it('lists only the caller’s houses, or all houses for an admin', async () => {
      const mine = await viewer()('GET', '/api/houses');
      expect(mine.json()).toEqual({
        houses: [{ id: houseId, name: 'Main house', role: 'viewer' }],
      });

      const all = await admin()('GET', '/api/houses');
      expect(all.json()).toEqual({
        houses: [
          { id: houseId, name: 'Main house', role: null },
          { id: otherHouseId, name: 'Other house', role: null },
        ],
      });

      const none = await stranger()('GET', '/api/houses');
      expect(none.json()).toEqual({ houses: [] });
    });

    it('returns 404 for a house the caller is not a member of', async () => {
      for (const url of [`/api/houses/${otherHouseId}`, `/api/houses/${otherHouseId}/members`]) {
        expect((await owner()('GET', url)).statusCode, url).toBe(404);
      }
      expect((await stranger()('GET', `/api/houses/${houseId}`)).statusCode).toBe(404);
    });

    it('returns the same 404 for a house that does not exist', async () => {
      const res = await owner()('GET', '/api/houses/999999');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found', message: 'House not found' });
    });

    it('lets an admin view any house', async () => {
      expect((await detail(otherHouseId, admin())).role).toBeNull();
    });

    it('rejects non-numeric IDs', async () => {
      expect((await owner()('GET', '/api/houses/abc')).statusCode).toBe(400);
      expect((await owner()('GET', '/api/houses/0')).statusCode).toBe(400);
    });
  });

  describe('permissions per role', () => {
    type Who = 'admin' | 'owner' | 'editor' | 'viewer' | 'stranger';
    const as = (who: Who) => ({ admin, owner, editor, viewer, stranger })[who]();

    const cases: {
      name: string;
      call: (
        h: HouseDetail,
      ) => [method: 'PATCH' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown];
      allowed: Who[];
    }[] = [
      {
        name: 'rename house',
        call: () => ['PATCH', `/api/houses/${houseId}`, { name: 'Renamed' }],
        allowed: ['admin', 'owner'],
      },
      {
        name: 'add member',
        call: () => ['PUT', `/api/houses/${houseId}/members/new@example.com`, { role: 'viewer' }],
        allowed: ['admin', 'owner'],
      },
      {
        name: 'add area',
        call: () => ['POST', `/api/houses/${houseId}/areas`, { name: 'Mudroom', zone: 'laundry' }],
        allowed: ['admin', 'owner', 'editor'],
      },
      {
        name: 'rename area',
        call: (h) => [
          'PATCH',
          `/api/houses/${houseId}/areas/${areaByType(h, 'garage').id}`,
          { name: 'Shop' },
        ],
        allowed: ['admin', 'owner', 'editor'],
      },
      {
        name: 'move item',
        call: (h) => [
          'PUT',
          `/api/houses/${houseId}/items/${itemBySlug(h, 'electrical-panel').id}/placements`,
          { areaIds: [areaByType(h, 'basement').id] },
        ],
        allowed: ['admin', 'owner', 'editor'],
      },
      {
        name: 'hide item',
        call: (h) => [
          'PUT',
          `/api/houses/${houseId}/items/${itemBySlug(h, 'well-pump').id}/hidden`,
          { hidden: true },
        ],
        allowed: ['admin', 'owner', 'editor'],
      },
      {
        name: 'delete house',
        call: () => ['DELETE', `/api/houses/${houseId}`],
        allowed: ['admin'],
      },
    ];

    const matrix = cases.flatMap((c) =>
      (['admin', 'owner', 'editor', 'viewer', 'stranger'] as const).map((who) => ({
        ...c,
        who,
        expected: c.allowed.includes(who)
          ? 'allowed'
          : who === 'stranger' && c.name !== 'delete house'
            ? 404
            : 403,
      })),
    );

    it.each(matrix)('$who: $name → $expected', async ({ who, call, expected }) => {
      const house = await detail(houseId, admin());
      const [method, url, body] = call(house);
      const res = await as(who)(method, url, body);
      if (expected === 'allowed') {
        expect(res.statusCode, res.body).toBeLessThan(300);
      } else {
        expect(res.statusCode, res.body).toBe(expected);
      }
    });
  });

  describe('members', () => {
    it('changes a role and removes a member', async () => {
      const change = await owner()('PUT', `/api/houses/${houseId}/members/${VIEWER}`, {
        role: 'editor',
      });
      expect(change.statusCode).toBe(200);
      const remove = await owner()('DELETE', `/api/houses/${houseId}/members/${EDITOR}`);
      expect(remove.statusCode).toBe(204);
      const list = await owner()('GET', `/api/houses/${houseId}/members`);
      expect(list.json()).toEqual({
        members: [
          { email: OWNER, role: 'owner' },
          { email: VIEWER, role: 'editor' },
        ],
      });
    });

    it('matches member emails case-insensitively', async () => {
      const res = await owner()('PUT', `/api/houses/${houseId}/members/Viewer@Example.com`, {
        role: 'editor',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ email: VIEWER, role: 'editor' });
    });

    it('keeps at least one owner', async () => {
      const demote = await owner()('PUT', `/api/houses/${houseId}/members/${OWNER}`, {
        role: 'editor',
      });
      expect(demote.statusCode).toBe(409);
      const remove = await admin()('DELETE', `/api/houses/${houseId}/members/${OWNER}`);
      expect(remove.statusCode).toBe(409);

      await owner()('PUT', `/api/houses/${houseId}/members/${EDITOR}`, { role: 'owner' });
      const nowOk = await owner()('DELETE', `/api/houses/${houseId}/members/${OWNER}`);
      expect(nowOk.statusCode).toBe(204);
    });

    it('keeps an owner when two owners are demoted at the same time', async () => {
      // Repeated to give the race a real chance to interleave.
      for (let round = 0; round < 10; round++) {
        await admin()('PUT', `/api/houses/${houseId}/members/${OWNER}`, { role: 'owner' });
        await admin()('PUT', `/api/houses/${houseId}/members/${EDITOR}`, { role: 'owner' });
        const results = await Promise.all([
          owner()('PUT', `/api/houses/${houseId}/members/${OWNER}`, { role: 'viewer' }),
          editor()('PUT', `/api/houses/${houseId}/members/${EDITOR}`, { role: 'viewer' }),
        ]);
        expect(results.map((r) => r.statusCode).sort(), `round ${round}`).toEqual([200, 409]);
        const owners = await db
          .selectFrom('house_members')
          .select('email')
          .where('house_id', '=', houseId)
          .where('role', '=', 'owner')
          .execute();
        expect(owners, `round ${round}`).toHaveLength(1);
      }
    });

    it('returns 404 when removing someone who is not a member', async () => {
      const res = await owner()('DELETE', `/api/houses/${houseId}/members/${STRANGER}`);
      expect(res.statusCode).toBe(404);
    });

    it('rejects an invalid role or email', async () => {
      expect(
        (await owner()('PUT', `/api/houses/${houseId}/members/${STRANGER}`, { role: 'god' }))
          .statusCode,
      ).toBe(400);
      expect(
        (await owner()('PUT', `/api/houses/${houseId}/members/not-an-email`, { role: 'viewer' }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe('areas', () => {
    it('adds a custom area and a second area of an existing type', async () => {
      const mudroom = await editor()('POST', `/api/houses/${houseId}/areas`, {
        name: 'Mudroom',
        zone: 'laundry',
      });
      expect(mudroom.statusCode, mudroom.body).toBe(201);
      const bathroomType = (await detail(houseId)).areas.find((a) => a.areaTypeSlug === 'bathroom');
      const second = await editor()('POST', `/api/houses/${houseId}/areas`, {
        areaTypeId: bathroomType?.areaTypeId,
        name: 'Upstairs bathroom',
      });
      expect(second.statusCode, second.body).toBe(201);

      const house = await detail(houseId);
      expect(house.areas.find((a) => a.id === mudroom.json<{ id: number }>().id)).toMatchObject({
        name: 'Mudroom',
        zone: 'laundry',
        areaTypeId: null,
      });
      expect(house.areas.find((a) => a.id === second.json<{ id: number }>().id)).toMatchObject({
        name: 'Upstairs bathroom',
        zone: 'bathroom',
        areaTypeSlug: 'bathroom',
      });
    });

    it('requires a name and zone for a custom area', async () => {
      expect(
        (await editor()('POST', `/api/houses/${houseId}/areas`, { zone: 'laundry' })).statusCode,
      ).toBe(400);
      expect(
        (await editor()('POST', `/api/houses/${houseId}/areas`, { name: 'Den' })).statusCode,
      ).toBe(400);
      expect(
        (await editor()('POST', `/api/houses/${houseId}/areas`, { name: 'Den', zone: 'overlay' }))
          .statusCode,
      ).toBe(400);
    });

    it('refuses system area types as rooms', async () => {
      const electrical = await db
        .selectFrom('area_types')
        .select('id')
        .where('slug', '=', 'electrical')
        .executeTakeFirstOrThrow();
      const res = await editor()('POST', `/api/houses/${houseId}/areas`, {
        areaTypeId: electrical.id,
      });
      expect(res.statusCode).toBe(400);
    });

    it('renames, hides and reorders an area', async () => {
      const garage = areaByType(await detail(houseId), 'garage');
      const res = await editor()('PATCH', `/api/houses/${houseId}/areas/${garage.id}`, {
        name: 'Two-car garage',
        hidden: true,
        sortOrder: 5,
      });
      expect(res.statusCode, res.body).toBe(204);
      expect(areaByType(await detail(houseId), 'garage')).toMatchObject({
        name: 'Two-car garage',
        hidden: true,
        sortOrder: 5,
      });
    });

    it('rejects an empty update', async () => {
      const garage = areaByType(await detail(houseId), 'garage');
      expect(
        (await editor()('PATCH', `/api/houses/${houseId}/areas/${garage.id}`, {})).statusCode,
      ).toBe(400);
    });

    it('deletes an area and the item placements in it', async () => {
      let house = await detail(houseId);
      const garage = areaByType(house, 'garage');
      expect(
        (await editor()('DELETE', `/api/houses/${houseId}/areas/${garage.id}`)).statusCode,
      ).toBe(204);
      house = await detail(houseId);
      expect(house.areas.some((a) => a.id === garage.id)).toBe(false);
      expect(itemBySlug(house, 'electrical-panel').areaIds).toEqual([]);
    });

    it('cannot touch another house’s area through this house', async () => {
      const otherGarage = areaByType(await detail(otherHouseId, admin()), 'garage');
      const rename = await owner()('PATCH', `/api/houses/${houseId}/areas/${otherGarage.id}`, {
        name: 'Hijacked',
      });
      expect(rename.statusCode).toBe(404);
      const del = await owner()('DELETE', `/api/houses/${houseId}/areas/${otherGarage.id}`);
      expect(del.statusCode).toBe(404);
      expect(areaByType(await detail(otherHouseId, admin()), 'garage').name).toBe('Garage');
    });
  });

  describe('items', () => {
    it('moves the electrical panel from the garage to the basement in one house only', async () => {
      const house = await detail(houseId);
      const panel = itemBySlug(house, 'electrical-panel');
      const basement = areaByType(house, 'basement');
      const res = await editor()('PUT', `/api/houses/${houseId}/items/${panel.id}/placements`, {
        areaIds: [basement.id, basement.id],
      });
      expect(res.statusCode, res.body).toBe(204);
      expect(itemBySlug(await detail(houseId), 'electrical-panel').areaIds).toEqual([basement.id]);

      const other = await detail(otherHouseId, admin());
      expect(itemBySlug(other, 'electrical-panel').areaIds).toEqual([
        areaByType(other, 'garage').id,
      ]);
    });

    it('places an item in several areas, or none', async () => {
      const house = await detail(houseId);
      const fan = itemBySlug(house, 'ceiling-fan');
      const ids = [areaByType(house, 'bedroom').id, areaByType(house, 'living-room').id].sort(
        (a, b) => a - b,
      );
      await editor()('PUT', `/api/houses/${houseId}/items/${fan.id}/placements`, { areaIds: ids });
      expect(itemBySlug(await detail(houseId), 'ceiling-fan').areaIds).toEqual(ids);
      await editor()('PUT', `/api/houses/${houseId}/items/${fan.id}/placements`, { areaIds: [] });
      expect(itemBySlug(await detail(houseId), 'ceiling-fan').areaIds).toEqual([]);
    });

    it('refuses areas from another house and leaves placements unchanged', async () => {
      const house = await detail(houseId);
      const panel = itemBySlug(house, 'electrical-panel');
      const otherGarage = areaByType(await detail(otherHouseId, admin()), 'garage');
      const res = await editor()('PUT', `/api/houses/${houseId}/items/${panel.id}/placements`, {
        areaIds: [areaByType(house, 'basement').id, otherGarage.id],
      });
      expect(res.statusCode).toBe(400);
      expect(itemBySlug(await detail(houseId), 'electrical-panel').areaIds).toEqual(panel.areaIds);
    });

    it('refuses to place a whole-house item', async () => {
      const house = await detail(houseId);
      const res = await editor()(
        'PUT',
        `/api/houses/${houseId}/items/${itemBySlug(house, 'thermostat').id}/placements`,
        {
          areaIds: [areaByType(house, 'kitchen').id],
        },
      );
      expect(res.statusCode).toBe(400);
    });

    it('hides and shows an item (idempotently)', async () => {
      const well = itemBySlug(await detail(houseId), 'well-pump');
      const url = `/api/houses/${houseId}/items/${well.id}/hidden`;
      expect((await editor()('PUT', url, { hidden: true })).statusCode).toBe(204);
      expect((await editor()('PUT', url, { hidden: true })).statusCode).toBe(204);
      expect(itemBySlug(await detail(houseId), 'well-pump').hidden).toBe(true);
      expect(itemBySlug(await detail(otherHouseId, admin()), 'well-pump').hidden).toBe(false);
      expect((await editor()('PUT', url, { hidden: false })).statusCode).toBe(204);
      expect(itemBySlug(await detail(houseId), 'well-pump').hidden).toBe(false);
    });

    it('returns 404 for an unknown item', async () => {
      const res = await editor()('PUT', `/api/houses/${houseId}/items/999999/hidden`, {
        hidden: true,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('deleting a house', () => {
    it('removes private videos, house tags and layout, but nothing shared or from other houses', async () => {
      await db
        .insertInto('videos')
        .values([
          { youtube_id: 'aaaaaaaaaaa', house_id: houseId, source: 'manual', added_by: OWNER },
          {
            youtube_id: 'bbbbbbbbbbb',
            house_id: otherHouseId,
            source: 'manual',
            added_by: OTHER_OWNER,
          },
          { youtube_id: 'ccccccccccc', house_id: null, source: 'manual', added_by: ADMIN },
        ])
        .execute();
      await db
        .insertInto('tags')
        .values({ house_id: houseId, slug: 'our-reno', name: 'Our reno' })
        .execute();

      const res = await admin()('DELETE', `/api/houses/${houseId}`);
      expect(res.statusCode, res.body).toBe(204);

      expect(
        await db.selectFrom('houses').select('id').where('id', '=', houseId).execute(),
      ).toEqual([]);
      const videos = await db
        .selectFrom('videos')
        .select('youtube_id')
        .orderBy('youtube_id')
        .execute();
      expect(videos.map((v) => v.youtube_id)).toEqual(['bbbbbbbbbbb', 'ccccccccccc']);
      expect(
        await db.selectFrom('tags').select('id').where('house_id', '=', houseId).execute(),
      ).toEqual([]);
      expect(
        await db.selectFrom('house_areas').select('id').where('house_id', '=', houseId).execute(),
      ).toEqual([]);

      const audit = await db
        .selectFrom('audit_log')
        .select('details')
        .where('action', '=', 'house.delete')
        .executeTakeFirstOrThrow();
      expect(audit.details).toEqual({
        name: 'Main house',
        privateVideosDeleted: 1,
        houseTagsDeleted: 1,
      });
    });

    it('returns 404 for an unknown house', async () => {
      expect((await admin()('DELETE', '/api/houses/999999')).statusCode).toBe(404);
    });
  });
});
