/**
 * Browser-test server, run by Playwright's webServer as a separate Node process:
 * resets the test database, then serves the real API and built pages on E2E_PORT.
 * The Access signing key is written to E2E_STATE_FILE so tests can sign in.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { buildApp } from '../../src/app.js';
import { createAccessVerifier } from '../../src/auth/access.js';
import { migrateToLatest } from '../../src/db/migrate.js';
import { TEST_ACCESS } from '../helpers/access-tokens.js';
import { createTestDb, resetDatabase } from '../integration/db.js';
import { ADMIN, E2E_PORT, E2E_STATE_FILE } from './config.js';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

const db = createTestDb();
await resetDatabase(db);
await migrateToLatest(db);

const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'RS256' };
writeFileSync(
  E2E_STATE_FILE,
  JSON.stringify({ privateJwk: { ...(await exportJWK(privateKey)), kid: 'e2e', alg: 'RS256' } }),
  { mode: 0o600 },
);

const baseUrl = `http://127.0.0.1:${E2E_PORT}`;
const app = await buildApp({
  config: {
    publicOrigin: baseUrl,
    adminEmails: new Set([ADMIN]),
    logLevel: 'warn',
    webRoot: WEB_ROOT,
  },
  db,
  verifyAccess: createAccessVerifier(TEST_ACCESS, createLocalJWKSet({ keys: [publicJwk] })),
});
await app.listen({ host: '127.0.0.1', port: E2E_PORT });

const stop = () => {
  void app.close().then(() => db.destroy());
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
