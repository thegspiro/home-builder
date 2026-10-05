import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateToLatest, MIGRATIONS } from '../../src/db/migrate.js';
import * as m0001 from '../../src/db/migrations/0001_initial_schema.js';
import * as m0002 from '../../src/db/migrations/0002_seed_catalog.js';
import * as m0003 from '../../src/db/migrations/0003_inbox_suggestions.js';
import type { Database } from '../../src/db/schema.js';
import { AREA_TYPES, ITEMS, TAGS } from '../../src/db/seed-data.js';
import { count, createTestDb, listTables, resetDatabase } from './db.js';

const APP_TABLES = [
  'area_types',
  'audit_log',
  'house_areas',
  'house_hidden_items',
  'house_item_placements',
  'house_members',
  'houses',
  'import_jobs',
  'item_default_placements',
  'items',
  'keyword_rules',
  'playlists',
  'tags',
  'video_area_types',
  'video_house_areas',
  'video_items',
  'video_tags',
  'videos',
];

const KYSELY_TABLES = ['kysely_migration', 'kysely_migration_lock'];

describe('migrations', () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = createTestDb();
    await resetDatabase(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('applies every migration to an empty database', async () => {
    expect(await migrateToLatest(db)).toEqual(Object.keys(MIGRATIONS));
    expect(await listTables(db)).toEqual([...APP_TABLES, ...KYSELY_TABLES].sort());
  });

  it('seeds the catalog exactly', async () => {
    expect(await count(db, 'area_types')).toBe(AREA_TYPES.length);
    expect(await count(db, 'items')).toBe(ITEMS.length);
    expect(await count(db, 'tags')).toBe(TAGS.length);
    expect(await count(db, 'item_default_placements')).toBe(
      ITEMS.reduce((n, item) => n + item.defaultAreas.length, 0),
    );

    const panel = await db
      .selectFrom('items as i')
      .innerJoin('item_default_placements as p', 'p.item_id', 'i.id')
      .innerJoin('area_types as a', 'a.id', 'p.area_type_id')
      .leftJoin('area_types as s', 's.id', 'i.system_area_type_id')
      .select(['a.slug as area', 's.slug as system', 'i.whole_house'])
      .where('i.slug', '=', 'electrical-panel')
      .executeTakeFirstOrThrow();
    expect(panel).toEqual({ area: 'garage', system: 'electrical', whole_house: 0 });

    const thermostat = await db
      .selectFrom('items')
      .select('whole_house')
      .where('slug', '=', 'thermostat')
      .executeTakeFirstOrThrow();
    expect(thermostat.whole_house).toBe(1);

    const sharedTags = await db
      .selectFrom('tags')
      .select('id')
      .where('house_id', 'is', null)
      .execute();
    expect(sharedTags).toHaveLength(TAGS.length);
  });

  it('is a no-op when already up to date', async () => {
    expect(await migrateToLatest(db)).toEqual([]);
  });

  it('re-running each migration body is safe (interrupted-run recovery)', async () => {
    const raw = db as unknown as Kysely<unknown>;
    await m0001.up(raw);
    await m0002.up(raw);
    expect(await count(db, 'area_types')).toBe(AREA_TYPES.length);
    expect(await count(db, 'items')).toBe(ITEMS.length);
    expect(await count(db, 'tags')).toBe(TAGS.length);
  });

  it('keeps catalog edits made in the app across restarts', async () => {
    await db
      .updateTable('area_types')
      .set({ name: 'Two-car garage' })
      .where('slug', '=', 'garage')
      .execute();
    await db
      .deleteFrom('tags')
      .where('slug', '=', 'welding')
      .where('house_id', 'is', null)
      .execute();
    await migrateToLatest(db);
    const garage = await db
      .selectFrom('area_types')
      .select('name')
      .where('slug', '=', 'garage')
      .executeTakeFirstOrThrow();
    expect(garage.name).toBe('Two-car garage');
    expect(await count(db, 'tags')).toBe(TAGS.length - 1);
  });

  it('0003 adds video_tags.suggested, keeps existing links confirmed, and rolls back', async () => {
    // Undo 0003, add a tag link the old way, then re-apply.
    expect(await migrateDown(db)).toEqual(['0003_inbox_suggestions']);
    await sql`INSERT INTO videos (youtube_id, source, added_by) VALUES ('ddddddddddd', 'manual', 'x@example.com')`.execute(
      db,
    );
    await sql`
      INSERT INTO video_tags (video_id, tag_id)
      SELECT v.id, t.id FROM videos v, tags t
      WHERE v.youtube_id = 'ddddddddddd' AND t.slug = 'repair' AND t.house_id IS NULL
    `.execute(db);
    expect(await migrateToLatest(db)).toEqual(['0003_inbox_suggestions']);
    const link = await db.selectFrom('video_tags').select('suggested').executeTakeFirstOrThrow();
    expect(link.suggested).toBe(0);
    // Re-running the body is a no-op.
    await m0003.up(db as unknown as Kysely<unknown>);
    await db.deleteFrom('videos').execute();
  });

  it('0003 adds the apply_rules job type and its rollback removes those jobs only', async () => {
    const job = (type: 'apply_rules' | 'paste_import') =>
      db
        .insertInto('import_jobs')
        .values({ type, payload: '{}', created_by: 'x@example.com' })
        .execute();
    await job('apply_rules');
    await job('paste_import');

    expect(await migrateDown(db)).toEqual(['0003_inbox_suggestions']);
    const left = await db.selectFrom('import_jobs').select('type').execute();
    expect(left).toEqual([{ type: 'paste_import' }]);
    await expect(job('apply_rules')).rejects.toMatchObject({ code: 'WARN_DATA_TRUNCATED' });

    expect(await migrateToLatest(db)).toEqual(['0003_inbox_suggestions']);
    await job('apply_rules');
    await db.deleteFrom('import_jobs').execute();
  });

  it('rolls back down to an empty schema and back up again', async () => {
    expect(await migrateDown(db)).toEqual(['0003_inbox_suggestions']);
    expect(await migrateDown(db)).toEqual(['0002_seed_catalog']);
    expect(await count(db, 'area_types')).toBe(0);
    expect(await count(db, 'items')).toBe(0);
    expect(await count(db, 'tags')).toBe(0);

    expect(await migrateDown(db)).toEqual(['0001_initial_schema']);
    expect(await listTables(db)).toEqual(KYSELY_TABLES);

    expect(await migrateToLatest(db)).toEqual(Object.keys(MIGRATIONS));
    expect(await count(db, 'items')).toBe(ITEMS.length);
  });
});
