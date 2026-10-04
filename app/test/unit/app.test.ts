import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createAccessVerifier } from '../../src/auth/access.js';
import { assertCan } from '../../src/auth/policy.js';
import { createTokenFactory, TEST_ACCESS, type TokenFactory } from '../helpers/access-tokens.js';
import { createDummyDb } from '../helpers/dummy-db.js';

const ORIGIN = 'https://videos.example.com';

describe('HTTP app (no database)', () => {
  let app: FastifyInstance;
  let tokens: TokenFactory;

  beforeAll(async () => {
    tokens = await createTokenFactory();
    app = await buildApp({
      config: {
        publicOrigin: ORIGIN,
        adminEmails: new Set(['admin@example.com']),
        logLevel: 'silent',
      },
      db: createDummyDb(),
      verifyAccess: createAccessVerifier(TEST_ACCESS, tokens.keySet),
      logger: false,
    });
    // Test-only routes to exercise the shared hooks and error handling.
    app.post('/api/test/echo', (request, reply) =>
      reply.send({ body: request.body, who: request.principal }),
    );
    app.get('/api/test/admin-only', (request, reply) => {
      assertCan(request.principal, 'library.edit');
      return reply.send({ ok: true });
    });
    app.get('/api/test/boom', () => {
      throw new Error('secret internal detail');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = async (email = 'user@example.com') => ({
    'cf-access-jwt-assertion': await tokens.sign({ email }),
  });

  it('serves /healthz without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('does not treat /healthz lookalikes as public', async () => {
    for (const url of ['/healthz/', '/healthz/../api/me', '/HEALTHZ']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('rejects API requests without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects unknown paths without a token (no route discovery)', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the signed-in user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: await auth('Someone@Example.com'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'someone@example.com', isAdmin: false, houses: [] });
  });

  it('marks ADMIN_EMAILS users as admins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: await auth('ADMIN@example.com'),
    });
    expect(res.json()).toMatchObject({ email: 'admin@example.com', isAdmin: true });
  });

  it('turns policy denials into 403', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/api/test/admin-only',
      headers: await auth(),
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/test/admin-only',
      headers: await auth('admin@example.com'),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('hides internal error details', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/boom', headers: await auth() });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internal detail');
  });

  it('sets security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain('https://www.youtube-nocookie.com');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  describe('state-changing requests (CSRF)', () => {
    it('accepts same-origin JSON', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/test/echo',
        headers: { ...(await auth()), origin: ORIGIN, 'content-type': 'application/json' },
        payload: { hello: 'world' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ body: { hello: 'world' } });
    });

    it('rejects a missing Origin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/test/echo',
        headers: { ...(await auth()), 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a foreign Origin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/test/echo',
        headers: {
          ...(await auth()),
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects non-JSON bodies with 415', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/test/echo',
        headers: { ...(await auth()), origin: ORIGIN, 'content-type': 'text/plain' },
        payload: '{"hello":"world"}',
      });
      expect(res.statusCode).toBe(415);
    });

    it('checks the token before the origin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/test/echo',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
