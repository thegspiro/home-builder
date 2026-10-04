/**
 * Integration-test database helpers. Uses the DATABASE_* environment variables, which
 * must point at a disposable MySQL 8.4 database: tests drop every table in it.
 */
import { sql, type Kysely } from 'kysely';
import { loadDatabaseConfig } from '../../src/config.js';
import { createDb } from '../../src/db/connection.js';
import type { Database } from '../../src/db/schema.js';

export function createTestDb(): Kysely<Database> {
  const config = loadDatabaseConfig();
  if (!/test/i.test(config.database)) {
    throw new Error(
      `Refusing to run integration tests against "${config.database}": the database name must contain "test"`,
    );
  }
  return createDb({ ...config, connectionLimit: 5 });
}

export async function listTables(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT TABLE_NAME AS name FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `.execute(db);
  return result.rows.map((r) => r.name);
}

/** Drops every table in the test database, including Kysely's migration bookkeeping. */
export async function resetDatabase(db: Kysely<Database>): Promise<void> {
  const tables = await listTables(db);
  await db.connection().execute(async (conn) => {
    await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(conn);
    try {
      for (const table of tables) {
        await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(conn);
      }
    } finally {
      await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(conn);
    }
  });
}

export async function count(db: Kysely<Database>, table: keyof Database): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
