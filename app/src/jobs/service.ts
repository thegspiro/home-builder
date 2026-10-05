/**
 * Enqueuing and reading import jobs. The worker runs them; payload shapes are the
 * contract in docs/JOBS.md.
 */
import type { Kysely, Selectable } from 'kysely';
import { writeAudit } from '../audit.js';
import type { Principal } from '../auth/policy.js';
import type { Database, ImportJobsTable, JobStatus, JobType } from '../db/schema.js';

type Db = Kysely<Database>;

export type JobPayload =
  | { type: 'paste_import'; payload: { text: string } }
  | { type: 'csv_import'; payload: { csv: string } }
  | { type: 'playlist_sync'; payload: { playlistId: number } }
  | { type: 'metadata_refresh'; payload: { videoIds?: number[] } }
  | { type: 'apply_rules'; payload: Record<string, never> };

export interface JobView {
  id: number;
  type: JobType;
  houseId: number | null;
  status: JobStatus;
  result: unknown;
  error: string | null;
  attempts: number;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export function toJobView(row: Selectable<ImportJobsTable>): JobView {
  return {
    id: row.id,
    type: row.type,
    houseId: row.house_id,
    status: row.status,
    result: row.result,
    error: row.error,
    attempts: row.attempts,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function enqueueJob(
  db: Db,
  principal: Principal,
  houseId: number | null,
  job: JobPayload,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const result = await trx
      .insertInto('import_jobs')
      .values({
        type: job.type,
        house_id: houseId,
        payload: JSON.stringify(job.payload),
        created_by: principal.email,
      })
      .executeTakeFirstOrThrow();
    const jobId = Number(result.insertId);
    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'job.enqueue',
      entity: 'import_job',
      entityId: jobId,
      details: { type: job.type },
    });
    return jobId;
  });
}

/**
 * Returns a queued or running job of `type` matching `payloadKey = value`, so pressing
 * "Sync now" twice doesn't queue two syncs of the same playlist.
 */
export async function findActiveJob(
  db: Db,
  type: JobType,
  match?: { key: string; value: number },
): Promise<number | null> {
  const rows = await db
    .selectFrom('import_jobs')
    .select(['id', 'payload'])
    .where('type', '=', type)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('id')
    .execute();
  for (const row of rows) {
    if (!match) return row.id;
    const payload = row.payload as Record<string, unknown> | null;
    if (payload && payload[match.key] === match.value) return row.id;
  }
  return null;
}

export async function getJob(db: Db, jobId: number): Promise<JobView | null> {
  const row = await db
    .selectFrom('import_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();
  return row ? toJobView(row) : null;
}

/** Most recent jobs in one scope: the shared library (houseId null) or one house. */
export async function listJobs(db: Db, houseId: number | null, limit = 20): Promise<JobView[]> {
  const rows = await db
    .selectFrom('import_jobs')
    .selectAll()
    .where('house_id', houseId === null ? 'is' : '=', houseId)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toJobView);
}
