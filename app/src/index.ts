import { buildApp } from './app.js';
import { createAccessVerifier } from './auth/access.js';
import { loadConfig } from './config.js';
import { createDb } from './db/connection.js';
import { migrateToLatest } from './db/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.database);

  const app = await buildApp({
    config,
    db,
    verifyAccess: createAccessVerifier(config.access),
  });

  try {
    const applied = await migrateToLatest(db);
    app.log.info({ applied }, applied.length ? 'migrations applied' : 'database schema up to date');
  } catch (error) {
    app.log.fatal({ err: error }, 'database migration failed; refusing to start');
    await db.destroy();
    process.exitCode = 1;
    return;
  }

  if (config.adminEmails.size === 0) {
    app.log.warn('ADMIN_EMAILS is empty: nobody can edit the shared library or create houses');
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => db.destroy())
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'error during shutdown');
        process.exitCode = 1;
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  // Config errors land here before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
