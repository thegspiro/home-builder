import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/schema.js';
import { createTestDb, resetDatabase } from './db.js';

/** mysql2 error codes surfaced by the driver. */
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';
const ER_NO_REFERENCED_ROW = 'ER_NO_REFERENCED_ROW_2';
const ER_ROW_IS_REFERENCED = 'ER_ROW_IS_REFERENCED_2';
const ER_CHECK_CONSTRAINT = 'ER_CHECK_CONSTRAINT_VIOLATED';

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('schema constraints', () => {
  let db: Kysely<Database>;
  let houseA: number;
  let houseB: number;

  beforeAll(async () => {
    db = createTestDb();
    await resetDatabase(db);
    await migrateToLatest(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom('videos').execute();
    await db.deleteFrom('tags').where('house_id', 'is not', null).execute();
    await db.deleteFrom('houses').execute();
    houseA = Number(
      (
        await db
          .insertInto('houses')
          .values({ name: 'A', created_by: 'a@example.com' })
          .executeTakeFirstOrThrow()
      ).insertId,
    );
    houseB = Number(
      (
        await db
          .insertInto('houses')
          .values({ name: 'B', created_by: 'b@example.com' })
          .executeTakeFirstOrThrow()
      ).insertId,
    );
  });

  const video = (youtubeId: string, houseId: number | null) =>
    db
      .insertInto('videos')
      .values({
        youtube_id: youtubeId,
        house_id: houseId,
        source: 'manual',
        added_by: 'x@example.com',
      })
      .execute();

  it('allows a video once in the shared library and once per house', async () => {
    await video('dQw4w9WgXcQ', null);
    await video('dQw4w9WgXcQ', houseA);
    await video('dQw4w9WgXcQ', houseB);
    await expectCode(video('dQw4w9WgXcQ', null), ER_DUP_ENTRY);
    await expectCode(video('dQw4w9WgXcQ', houseA), ER_DUP_ENTRY);
  });

  it('treats YouTube IDs as case-sensitive', async () => {
    await video('abcdefghijk', null);
    await video('ABCDEFGHIJK', null);
  });

  it('rejects malformed YouTube IDs', async () => {
    await expectCode(video('bad id here', null), ER_CHECK_CONSTRAINT);
    await expectCode(video("x'--;drop--", null), ER_CHECK_CONSTRAINT);
  });

  it('scopes tag slugs to the shared library or a house', async () => {
    const tag = (slug: string, houseId: number | null) =>
      db
        .insertInto('tags')
        .values({ slug, name: slug, kind: 'other', house_id: houseId })
        .execute();
    await tag('my-project', houseA);
    await tag('my-project', houseB);
    await expectCode(tag('my-project', houseA), ER_DUP_ENTRY);
    // "install" is a seeded shared tag; a house may still have its own "install".
    await tag('install', houseA);
    await expectCode(tag('install', null), ER_DUP_ENTRY);
  });

  it('only lets an item be placed in an area of the same house', async () => {
    const areaInB = Number(
      (
        await db
          .insertInto('house_areas')
          .values({ house_id: houseB, name: 'Garage', zone: 'garage' })
          .executeTakeFirstOrThrow()
      ).insertId,
    );
    const item = await db
      .selectFrom('items')
      .select('id')
      .where('slug', '=', 'electrical-panel')
      .executeTakeFirstOrThrow();

    await expectCode(
      db
        .insertInto('house_item_placements')
        .values({ house_id: houseA, item_id: item.id, house_area_id: areaInB })
        .execute(),
      ER_NO_REFERENCED_ROW,
    );
    await db
      .insertInto('house_item_placements')
      .values({ house_id: houseB, item_id: item.id, house_area_id: areaInB })
      .execute();
  });

  it('blocks deleting a house that still has private videos or tags', async () => {
    await video('dQw4w9WgXcQ', houseA);
    await expectCode(
      db.deleteFrom('houses').where('id', '=', houseA).execute(),
      ER_ROW_IS_REFERENCED,
    );
    await db.deleteFrom('videos').where('house_id', '=', houseA).execute();

    await db
      .insertInto('tags')
      .values({ slug: 'mine', name: 'Mine', kind: 'other', house_id: houseA })
      .execute();
    await expectCode(
      db.deleteFrom('houses').where('id', '=', houseA).execute(),
      ER_ROW_IS_REFERENCED,
    );
  });

  it('cascades house-owned layout rows when a house is deleted', async () => {
    const areaId = Number(
      (
        await db
          .insertInto('house_areas')
          .values({ house_id: houseA, name: 'Garage', zone: 'garage' })
          .executeTakeFirstOrThrow()
      ).insertId,
    );
    const item = await db
      .selectFrom('items')
      .select('id')
      .where('slug', '=', 'water-heater')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('house_members')
      .values({ house_id: houseA, email: 'a@example.com', role: 'owner' })
      .execute();
    await db
      .insertInto('house_item_placements')
      .values({ house_id: houseA, item_id: item.id, house_area_id: areaId })
      .execute();
    await db
      .insertInto('house_hidden_items')
      .values({ house_id: houseA, item_id: item.id })
      .execute();

    await db.deleteFrom('houses').where('id', '=', houseA).execute();

    for (const table of [
      'house_areas',
      'house_members',
      'house_item_placements',
      'house_hidden_items',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().where('house_id', '=', houseA).execute();
      expect(rows, table).toEqual([]);
    }
  });

  it('stores and returns JSON payloads on import jobs', async () => {
    await db
      .insertInto('import_jobs')
      .values({
        type: 'paste_import',
        house_id: houseA,
        payload: JSON.stringify({ urls: ['x'] }),
        created_by: 'a@example.com',
      })
      .execute();
    const job = await db.selectFrom('import_jobs').selectAll().executeTakeFirstOrThrow();
    expect(job).toMatchObject({ status: 'queued', attempts: 0, payload: { urls: ['x'] } });
  });

  it('supports full-text search over titles', async () => {
    await db
      .insertInto('videos')
      .values({
        youtube_id: 'aaaaaaaaaaa',
        house_id: null,
        title: 'How to insulate a garage door',
        source: 'manual',
        added_by: 'x@example.com',
      })
      .execute();
    const result = await sql<{ id: number }>`
      SELECT id FROM videos WHERE MATCH(title, channel_name, notes) AGAINST (${'insulate'} IN BOOLEAN MODE)
    `.execute(db);
    expect(result.rows).toHaveLength(1);
  });
});
