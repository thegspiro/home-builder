import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationResultSet } from 'kysely/migration';
import * as m0001 from './migrations/0001_initial_schema.js';
import * as m0002 from './migrations/0002_seed_catalog.js';
import * as m0003 from './migrations/0003_inbox_suggestions.js';

/**
 * Migrations are registered explicitly (not discovered from the file system) so the
 * compiled build and the test runner always see the same, ordered set.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_initial_schema': m0001,
  '0002_seed_catalog': m0002,
  '0003_inbox_suggestions': m0003,
};

export function createMigrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...MIGRATIONS }) },
  });
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly results: MigrationResultSet['results'],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

function unwrap(direction: string, resultSet: MigrationResultSet): string[] {
  const applied = (resultSet.results ?? [])
    .filter((r) => r.status === 'Success')
    .map((r) => r.migrationName);
  if (resultSet.error !== undefined) {
    const failed = resultSet.results?.find((r) => r.status === 'Error')?.migrationName;
    throw new MigrationError(
      `Migration ${direction} failed${failed ? ` at ${failed}` : ''}`,
      resultSet.results,
      { cause: resultSet.error },
    );
  }
  return applied;
}

/** Applies all pending migrations. Kysely holds a MySQL GET_LOCK while it runs. */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  return unwrap('up', await createMigrator(db).migrateToLatest());
}

/** Rolls back the most recently applied migration. */
export async function migrateDown<DB>(db: Kysely<DB>): Promise<string[]> {
  return unwrap('down', await createMigrator(db).migrateDown());
}
