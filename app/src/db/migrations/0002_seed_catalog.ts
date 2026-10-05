/**
 * Seeds the starting catalog (docs/PLAN.md section 5.3).
 *
 * Runs once, as a migration, so later edits made in the app are never overwritten on
 * restart. Every insert is "insert if missing", so re-running after an interrupted
 * run is safe. All values are bound as parameters.
 *
 * Rollback removes only the seeded rows (matched by slug). Rolling back also removes
 * anything linked to those rows through ON DELETE CASCADE, such as video-to-area links.
 */
import { sql, type Kysely } from 'kysely';
import { AREA_TYPES, ITEMS, TAGS } from '../seed-data.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const [index, area] of AREA_TYPES.entries()) {
      await sql`
        INSERT INTO area_types (slug, name, category, default_zone, sort_order)
        VALUES (${area.slug}, ${area.name}, ${area.category}, ${area.zone}, ${index * 10})
        ON DUPLICATE KEY UPDATE id = id
      `.execute(trx);
    }

    for (const [index, item] of ITEMS.entries()) {
      await sql`
        INSERT INTO items (slug, name, system_area_type_id, whole_house, sort_order)
        VALUES (
          ${item.slug},
          ${item.name},
          (SELECT a.id FROM area_types a WHERE a.slug = ${item.system ?? null}),
          ${item.wholeHouse === true},
          ${index * 10}
        )
        ON DUPLICATE KEY UPDATE id = id
      `.execute(trx);

      for (const areaSlug of item.defaultAreas) {
        await sql`
          INSERT INTO item_default_placements (item_id, area_type_id)
          SELECT i.id, a.id FROM items i CROSS JOIN area_types a
          WHERE i.slug = ${item.slug} AND a.slug = ${areaSlug}
          ON DUPLICATE KEY UPDATE area_type_id = item_default_placements.area_type_id
        `.execute(trx);
      }
    }

    for (const tag of TAGS) {
      await sql`
        INSERT INTO tags (house_id, slug, name, kind)
        VALUES (NULL, ${tag.slug}, ${tag.name}, ${tag.kind})
        ON DUPLICATE KEY UPDATE id = id
      `.execute(trx);
    }
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const tagSlugs = TAGS.map((t) => t.slug);
    const itemSlugs = ITEMS.map((i) => i.slug);
    const areaSlugs = AREA_TYPES.map((a) => a.slug);

    await sql`DELETE FROM tags WHERE house_id IS NULL AND slug IN (${sql.join(tagSlugs)})`.execute(
      trx,
    );
    // item_default_placements rows go with their items (ON DELETE CASCADE).
    await sql`DELETE FROM items WHERE slug IN (${sql.join(itemSlugs)})`.execute(trx);
    await sql`DELETE FROM area_types WHERE slug IN (${sql.join(areaSlugs)})`.execute(trx);
  });
}
