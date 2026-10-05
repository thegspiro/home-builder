/** Builds the real app against the test database and sends signed-in requests to it. */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Kysely } from 'kysely';
import { buildApp } from '../../src/app.js';
import { createAccessVerifier } from '../../src/auth/access.js';
import type { Database } from '../../src/db/schema.js';
import { createTokenFactory, TEST_ACCESS, type TokenFactory } from '../helpers/access-tokens.js';

export const TEST_ORIGIN = 'https://videos.example.com';
export const ADMIN = 'admin@example.com';

export interface Client {
  app: FastifyInstance;
  as(
    email: string,
  ): (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ) => Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function createClient(db: Kysely<Database>): Promise<Client> {
  const tokens: TokenFactory = await createTokenFactory();
  const app = await buildApp({
    config: { publicOrigin: TEST_ORIGIN, adminEmails: new Set([ADMIN]), logLevel: 'silent' },
    db,
    verifyAccess: createAccessVerifier(TEST_ACCESS, tokens.keySet),
    logger: false,
  });
  await app.ready();
  return {
    app,
    as: (email) => async (method, url, body) => {
      const headers: Record<string, string> = {
        'cf-access-jwt-assertion': await tokens.sign({ email }),
        origin: TEST_ORIGIN,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      return app.inject({
        method,
        url,
        headers,
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    },
    close: () => app.close(),
  };
}
