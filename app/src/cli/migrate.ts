/**
 * Manual migration CLI.
 *   node dist/cli/migrate.js          apply all pending migrations
 *   node dist/cli/migrate.js down     roll back the most recent migration
 * Only DATABASE_* environment variables are needed.
 */
import { loadDatabaseConfig } from '../config.js';
import { createDb } from '../db/connection.js';
import { migrateDown, migrateToLatest } from '../db/migrate.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  if (command !== 'up' && command !== 'down') {
    console.error('Usage: migrate [up|down]');
    process.exitCode = 2;
    return;
  }
  const db = createDb({ ...loadDatabaseConfig(), connectionLimit: 1 });
  try {
    const applied = command === 'up' ? await migrateToLatest(db) : await migrateDown(db);
    console.log(
      applied.length === 0
        ? 'No migrations to run.'
        : `${command === 'up' ? 'Applied' : 'Rolled back'}: ${applied.join(', ')}`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
