import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createAccessVerifier } from '../../src/auth/access.js';
import { migrateToLatest } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/schema.js';
import { createTokenFactory, TEST_ACCESS, type TokenFactory } from '../helpers/access-tokens.js';
import { createTestDb, resetDatabase } from './db.js';

describe('GET /api/me and /healthz against MySQL', () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let tokens: TokenFactory;

  beforeAll(async () => {
    db = createTestDb();
    await resetDatabase(db);
    await migrateToLatest(db);
    tokens = await createTokenFactory();
    app = await buildApp({
      config: {
        publicOrigin: 'https://videos.example.com',
        adminEmails: new Set(),
        logLevel: 'silent',
      },
      db,
      verifyAccess: createAccessVerifier(TEST_ACCESS, tokens.keySet),
      logger: false,
    });

    const insertHouse = async (name: string) =>
      Number(
        (
          await db
            .insertInto('houses')
            .values({ name, created_by: 'x@example.com' })
            .executeTakeFirstOrThrow()
        ).insertId,
      );
    const main = await insertHouse('Main house');
    const cabin = await insertHouse('Cabin');
    const other = await insertHouse('Not mine');
    await db
      .insertInto('house_members')
      .values([
        { house_id: main, email: 'me@example.com', role: 'owner' },
        { house_id: cabin, email: 'me@example.com', role: 'viewer' },
        { house_id: other, email: 'someone@example.com', role: 'owner' },
      ])
      .execute();
  });

  afterAll(async () => {
    // Optional chaining: if beforeAll failed, report that error rather than a teardown crash.
    await app?.close();
    await db?.destroy();
  });

  it('reports healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('lists only the houses the user belongs to, with roles', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { 'cf-access-jwt-assertion': await tokens.sign({ email: 'Me@Example.com' }) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ houses: { name: string; role: string }[] }>();
    expect(body.houses.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'Cabin', role: 'viewer' },
      { name: 'Main house', role: 'owner' },
    ]);
  });

  it('returns no houses for a user with no memberships', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { 'cf-access-jwt-assertion': await tokens.sign({ email: 'new@example.com' }) },
    });
    expect(res.json()).toEqual({ email: 'new@example.com', isAdmin: false, houses: [] });
  });
});
