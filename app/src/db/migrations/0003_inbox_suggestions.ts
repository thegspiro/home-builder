/**
 * Inbox suggestions (Phase 3):
 *
 * 1. `video_tags.suggested`, so a tag proposed by a keyword rule waits in the inbox for
 *    confirmation, like `video_area_types.suggested` and `video_items.suggested`.
 *    Existing rows become confirmed tags (DEFAULT FALSE).
 * 2. Job type `apply_rules`, which re-runs keyword rules over videos still in the inbox.
 *
 * Both changes are additive. MySQL has no ADD COLUMN IF NOT EXISTS and DDL is not
 * transactional, so each step checks the current schema first and the migration is safe
 * to re-run after an interrupted start.
 *
 * Rollback drops the column (suggested/confirmed state is lost: every link becomes a
 * plain link) and deletes `apply_rules` job history rows, which the old ENUM can't hold.
 */
import { sql, type Kysely } from 'kysely';

const JOB_TYPES_BEFORE = "'playlist_sync','csv_import','paste_import','metadata_refresh'";
const JOB_TYPES_AFTER = `${JOB_TYPES_BEFORE},'apply_rules'`;

async function hasSuggestedColumn(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'video_tags' AND COLUMN_NAME = 'suggested'
  `.execute(db);
  return Number(result.rows[0]?.n ?? 0) > 0;
}

async function jobTypeColumn(db: Kysely<unknown>): Promise<string> {
  const result = await sql<{ t: string }>`
    SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'import_jobs' AND COLUMN_NAME = 'type'
  `.execute(db);
  return result.rows[0]?.t ?? '';
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasSuggestedColumn(db))) {
    await sql`ALTER TABLE video_tags ADD COLUMN suggested BOOLEAN NOT NULL DEFAULT FALSE`.execute(
      db,
    );
  }
  if (!(await jobTypeColumn(db)).includes("'apply_rules'")) {
    await sql
      .raw(`ALTER TABLE import_jobs MODIFY COLUMN type ENUM(${JOB_TYPES_AFTER}) NOT NULL`)
      .execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if ((await jobTypeColumn(db)).includes("'apply_rules'")) {
    await sql`DELETE FROM import_jobs WHERE type = 'apply_rules'`.execute(db);
    await sql
      .raw(`ALTER TABLE import_jobs MODIFY COLUMN type ENUM(${JOB_TYPES_BEFORE}) NOT NULL`)
      .execute(db);
  }
  if (await hasSuggestedColumn(db)) {
    await sql`ALTER TABLE video_tags DROP COLUMN suggested`.execute(db);
  }
}
