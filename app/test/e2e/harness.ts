/** Test-side helpers: sign in a browser context, call the API, reach the database. */
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { importJWK, SignJWT, type JWK } from 'jose';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/schema.js';
import { TEST_ACCESS } from '../helpers/access-tokens.js';
import { createTestDb } from '../integration/db.js';
import { ADMIN, BASE_URL, E2E_STATE_FILE } from './config.js';

export { ADMIN, BASE_URL } from './config.js';

export async function signToken(email: string): Promise<string> {
  const { privateJwk } = JSON.parse(readFileSync(E2E_STATE_FILE, 'utf8')) as { privateJwk: JWK };
  const key = await importJWK(privateJwk, 'RS256');
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
    .setIssuer(`https://${TEST_ACCESS.teamDomain}`)
    .setAudience(TEST_ACCESS.audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

/** Stands in for Cloudflare Access: adds the token only to requests for the app. */
export async function signIn(context: BrowserContext, email: string): Promise<void> {
  const token = await signToken(email);
  await context.route('**/*', async (route) => {
    if (!route.request().url().startsWith(BASE_URL)) {
      await route.abort(); // thumbnails and YouTube: no internet in tests
      return;
    }
    await route.continue({
      headers: { ...route.request().headers(), 'cf-access-jwt-assertion': token },
    });
  });
}

export async function api<T>(
  email: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'cf-access-jwt-assertion': await signToken(email),
      origin: BASE_URL,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function testDb(): Kysely<Database> {
  return createTestDb();
}

/** Fails the test on any script error or CSP violation in the page. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED'))
      errors.push(message.text());
  });
  return errors;
}

export async function catalogId(
  db: Kysely<Database>,
  table: 'tags' | 'area_types' | 'items',
  slug: string,
): Promise<number> {
  return (
    await db.selectFrom(table).select('id').where('slug', '=', slug).executeTakeFirstOrThrow()
  ).id;
}

/** A shared video with its metadata already fetched. */
export async function addVideo(
  db: Kysely<Database>,
  youtubeId: string,
  title: string,
  review: 'inbox' | 'sorted' = 'sorted',
): Promise<number> {
  const result = await db
    .insertInto('videos')
    .values({
      youtube_id: youtubeId,
      title,
      thumbnail_url: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      source: 'manual',
      added_by: ADMIN,
      metadata_status: 'ok',
      review_status: review,
    })
    .executeTakeFirstOrThrow();
  return Number(result.insertId);
}

/** Removes what earlier browser tests created, keeping the seeded catalog. */
export async function resetContent(db: Kysely<Database>): Promise<void> {
  for (const table of ['videos', 'keyword_rules', 'playlists', 'import_jobs'] as const) {
    await db.deleteFrom(table).execute();
  }
  await db.deleteFrom('tags').where('house_id', 'is not', null).execute();
  await db.deleteFrom('houses').execute();
}
