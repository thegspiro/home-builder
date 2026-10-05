import type { Kysely, Transaction } from 'kysely';
import type { Database } from './db/schema.js';

export interface AuditEntry {
  actorEmail: string;
  houseId: number | null;
  /** Verb, e.g. "house.create", "area.update". */
  action: string;
  /** Table-level noun, e.g. "house", "house_area". */
  entity: string;
  entityId: string | number | null;
  details?: Record<string, unknown>;
}

/** Records a change. Call inside the same transaction as the change itself. */
export async function writeAudit(
  db: Kysely<Database> | Transaction<Database>,
  entry: AuditEntry,
): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      actor_email: entry.actorEmail,
      house_id: entry.houseId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId === null ? null : String(entry.entityId),
      details: entry.details === undefined ? undefined : JSON.stringify(entry.details),
    })
    .execute();
}
