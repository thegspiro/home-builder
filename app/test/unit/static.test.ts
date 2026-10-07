import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createAccessVerifier } from '../../src/auth/access.js';
import { createTokenFactory, TEST_ACCESS, type TokenFactory } from '../helpers/access-tokens.js';
import { createDummyDb } from '../helpers/dummy-db.js';

describe('serving the web pages', () => {
  let app: FastifyInstance;
  let tokens: TokenFactory;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Search</title>');
    writeFileSync(join(root, 'admin.html'), '<!doctype html><title>Admin</title>');
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
    tokens = await createTokenFactory();
    app = await buildApp({
      config: {
        publicOrigin: 'https://videos.example.com',
        adminEmails: new Set(),
        logLevel: 'silent',
        webRoot: root,
      },
      db: createDummyDb(),
      verifyAccess: createAccessVerifier(TEST_ACCESS, tokens.keySet),
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const signedIn = async () => ({ 'cf-access-jwt-assertion': await tokens.sign() });

  it('requires the Access token for pages too', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/assets/index-abc123.js' })).statusCode).toBe(
      401,
    );
  });

  it('serves pages with no-cache and hashed assets as immutable', async () => {
    const page = await app.inject({ method: 'GET', url: '/', headers: await signedIn() });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Search</title>');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");

    const admin = await app.inject({
      method: 'GET',
      url: '/admin.html',
      headers: await signedIn(),
    });
    expect(admin.body).toContain('Admin');

    const asset = await app.inject({
      method: 'GET',
      url: '/assets/index-abc123.js',
      headers: await signedIn(),
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('does not serve files outside the web root', async () => {
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/assets/../../etc/passwd']) {
      const res = await app.inject({ method: 'GET', url, headers: await signedIn() });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('keeps API routes working alongside the pages', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: await signedIn() });
    expect(res.statusCode).toBe(200);
  });
});
