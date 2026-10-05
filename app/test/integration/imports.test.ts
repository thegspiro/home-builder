import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/schema.js';
import { ADMIN, createClient, type Client } from './app-client.js';
import { createTestDb, resetDatabase } from './db.js';

const OWNER = 'owner@example.com';
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';

describe('imports, playlists, jobs and keyword rules', () => {
  let db: Kysely<Database>;
  let client: Client;
  let houseId: number;

  beforeAll(async () => {
    db = createTestDb();
    await resetDatabase(db);
    await migrateToLatest(db);
    client = await createClient(db);
  });

  afterAll(async () => {
    await client?.close();
    await db?.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom('import_jobs').execute();
    await db.deleteFrom('playlists').execute();
    await db.deleteFrom('keyword_rules').execute();
    await db.deleteFrom('houses').execute();
    const res = await client.as(ADMIN)('POST', '/api/houses', { name: 'Home', ownerEmail: OWNER });
    houseId = res.json<{ id: number }>().id;
    await client.as(OWNER)('PUT', `/api/houses/${houseId}/members/${VIEWER}`, { role: 'viewer' });
  });

  async function jobRow(jobId: number) {
    return db
      .selectFrom('import_jobs')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
  }

  describe('paste and CSV imports', () => {
    it('queues a shared-library paste import for an admin', async () => {
      const res = await client.as(ADMIN)('POST', '/api/imports/paste', {
        text: 'https://youtu.be/aaaaaaaaaaa',
      });
      expect(res.statusCode, res.body).toBe(202);
      const job = await jobRow(res.json<{ jobId: number }>().jobId);
      expect(job).toMatchObject({
        type: 'paste_import',
        house_id: null,
        status: 'queued',
        payload: { text: 'https://youtu.be/aaaaaaaaaaa' },
        created_by: ADMIN,
      });
    });

    it('queues a house-private import for an owner, not for a viewer or stranger', async () => {
      const ok = await client.as(OWNER)('POST', '/api/imports/csv', {
        csv: 'Video ID\naaaaaaaaaaa',
        houseId,
      });
      expect(ok.statusCode, ok.body).toBe(202);
      expect((await jobRow(ok.json<{ jobId: number }>().jobId)).house_id).toBe(houseId);

      expect(
        (await client.as(VIEWER)('POST', '/api/imports/paste', { text: 'x', houseId })).statusCode,
      ).toBe(403);
      expect(
        (await client.as(STRANGER)('POST', '/api/imports/paste', { text: 'x', houseId }))
          .statusCode,
      ).toBe(404);
    });

    it('keeps non-admins out of the shared library', async () => {
      expect((await client.as(OWNER)('POST', '/api/imports/paste', { text: 'x' })).statusCode).toBe(
        403,
      );
      expect((await client.as(OWNER)('POST', '/api/imports/csv', { csv: 'x' })).statusCode).toBe(
        403,
      );
    });

    it('limits pasted lines and rejects empty or oversized input', async () => {
      const tooMany = Array.from(
        { length: 501 },
        (_, i) => `https://youtu.be/${String(i).padStart(11, '0')}`,
      );
      const res = await client.as(ADMIN)('POST', '/api/imports/paste', {
        text: tooMany.join('\n'),
      });
      expect(res.statusCode).toBe(400);
      expect((await client.as(ADMIN)('POST', '/api/imports/paste', { text: '' })).statusCode).toBe(
        400,
      );
      expect(
        (await client.as(ADMIN)('POST', '/api/imports/paste', { text: 'x'.repeat(200_001) }))
          .statusCode,
      ).toBe(400);
      expect(await db.selectFrom('import_jobs').select('id').execute()).toEqual([]);
    });

    it('accepts a large Takeout CSV', async () => {
      const rows = Array.from(
        { length: 5000 },
        (_, i) => `${String(i).padStart(11, 'a')},2024-01-01T00:00:00+00:00`,
      );
      const csv = ['Video ID,Playlist Video Creation Timestamp', ...rows].join('\n');
      const res = await client.as(ADMIN)('POST', '/api/imports/csv', { csv });
      expect(res.statusCode, res.body.slice(0, 200)).toBe(202);
    });
  });

  describe('job status', () => {
    it('shows house jobs to house members and shared jobs to admins only', async () => {
      const houseJob = (
        await client.as(OWNER)('POST', '/api/imports/paste', { text: 'x', houseId })
      ).json<{
        jobId: number;
      }>().jobId;
      const sharedJob = (await client.as(ADMIN)('POST', '/api/imports/paste', { text: 'x' })).json<{
        jobId: number;
      }>().jobId;

      const asViewer = await client.as(VIEWER)('GET', `/api/jobs/${houseJob}`);
      expect(asViewer.statusCode).toBe(200);
      expect(asViewer.json()).toMatchObject({
        id: houseJob,
        type: 'paste_import',
        status: 'queued',
        houseId,
      });
      expect((await client.as(STRANGER)('GET', `/api/jobs/${houseJob}`)).statusCode).toBe(404);
      expect((await client.as(OWNER)('GET', `/api/jobs/${sharedJob}`)).statusCode).toBe(404);
      expect((await client.as(ADMIN)('GET', `/api/jobs/${sharedJob}`)).statusCode).toBe(200);
      expect((await client.as(ADMIN)('GET', '/api/jobs/999999')).statusCode).toBe(404);

      const houseList = await client.as(VIEWER)('GET', `/api/jobs?houseId=${houseId}`);
      expect(houseList.json<{ jobs: { id: number }[] }>().jobs.map((j) => j.id)).toEqual([
        houseJob,
      ]);
      const sharedList = await client.as(ADMIN)('GET', '/api/jobs');
      expect(sharedList.json<{ jobs: { id: number }[] }>().jobs.map((j) => j.id)).toEqual([
        sharedJob,
      ]);
      expect((await client.as(OWNER)('GET', '/api/jobs')).statusCode).toBe(403);
    });
  });

  describe('playlists', () => {
    const URL = 'https://www.youtube.com/playlist?list=PLtest1234567890abcdef';

    it('adds a playlist, queues its first sync, and refuses duplicates', async () => {
      const res = await client.as(ADMIN)('POST', '/api/playlists', { url: URL });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json<{ id: number; youtubePlaylistId: string; jobId: number }>();
      expect(body.youtubePlaylistId).toBe('PLtest1234567890abcdef');
      expect(await jobRow(body.jobId)).toMatchObject({
        type: 'playlist_sync',
        payload: { playlistId: body.id },
      });

      expect(
        (await client.as(ADMIN)('POST', '/api/playlists', { url: 'PLtest1234567890abcdef' }))
          .statusCode,
      ).toBe(409);
      const list = await client.as(ADMIN)('GET', '/api/playlists');
      expect(list.json()).toMatchObject({
        playlists: [
          {
            id: body.id,
            youtubePlaylistId: 'PLtest1234567890abcdef',
            title: null,
            lastSyncedAt: null,
          },
        ],
      });
    });

    it('does not queue a second sync while one is pending', async () => {
      const { id, jobId } = (await client.as(ADMIN)('POST', '/api/playlists', { url: URL })).json<{
        id: number;
        jobId: number;
      }>();
      const again = await client.as(ADMIN)('POST', `/api/playlists/${id}/sync`);
      expect(again.json()).toEqual({ jobId, alreadyQueued: true });

      await db
        .updateTable('import_jobs')
        .set({ status: 'succeeded' })
        .where('id', '=', jobId)
        .execute();
      const fresh = await client.as(ADMIN)('POST', `/api/playlists/${id}/sync`);
      expect(fresh.json<{ jobId: number; alreadyQueued: boolean }>()).toMatchObject({
        alreadyQueued: false,
      });
      expect(fresh.json<{ jobId: number }>().jobId).not.toBe(jobId);
    });

    it('rejects bad URLs, unknown playlists and non-admins', async () => {
      expect(
        (await client.as(ADMIN)('POST', '/api/playlists', { url: 'https://example.com/x' }))
          .statusCode,
      ).toBe(400);
      expect((await client.as(ADMIN)('POST', '/api/playlists/999999/sync')).statusCode).toBe(404);
      expect((await client.as(ADMIN)('DELETE', '/api/playlists/999999')).statusCode).toBe(404);
      expect((await client.as(OWNER)('POST', '/api/playlists', { url: URL })).statusCode).toBe(403);
      expect((await client.as(OWNER)('GET', '/api/playlists')).statusCode).toBe(403);
    });

    it('removes a playlist but keeps its videos', async () => {
      const { id } = (await client.as(ADMIN)('POST', '/api/playlists', { url: URL })).json<{
        id: number;
      }>();
      await db
        .insertInto('videos')
        .values({ youtube_id: 'aaaaaaaaaaa', source: 'playlist', added_by: ADMIN })
        .execute();
      expect((await client.as(ADMIN)('DELETE', `/api/playlists/${id}`)).statusCode).toBe(204);
      expect(await db.selectFrom('videos').select('youtube_id').execute()).toEqual([
        { youtube_id: 'aaaaaaaaaaa' },
      ]);
      await db.deleteFrom('videos').execute();
    });
  });

  describe('keyword rules', () => {
    async function ids() {
      const tag = await db
        .selectFrom('tags')
        .select('id')
        .where('slug', '=', 'repair')
        .where('house_id', 'is', null)
        .executeTakeFirstOrThrow();
      const area = await db
        .selectFrom('area_types')
        .select('id')
        .where('slug', '=', 'garage')
        .executeTakeFirstOrThrow();
      const item = await db
        .selectFrom('items')
        .select('id')
        .where('slug', '=', 'garage-door')
        .executeTakeFirstOrThrow();
      return { tag: tag.id, area: area.id, item: item.id };
    }

    it('creates, lists, updates and deletes rules', async () => {
      const { tag, area, item } = await ids();
      const admin = client.as(ADMIN);
      for (const body of [
        { phrase: '  Garage   door ', itemId: item },
        { phrase: 'garage', areaTypeId: area },
        { phrase: 'fix', tagId: tag, enabled: false },
      ]) {
        expect((await admin('POST', '/api/keyword-rules', body)).statusCode).toBe(201);
      }
      const list = (await admin('GET', '/api/keyword-rules')).json<{
        rules: {
          id: number;
          phrase: string;
          enabled: boolean;
          target: { kind: string; name: string };
        }[];
      }>().rules;
      expect(
        list.map(({ phrase, enabled, target }) => ({
          phrase,
          enabled,
          kind: target.kind,
          name: target.name,
        })),
      ).toEqual([
        { phrase: 'fix', enabled: false, kind: 'tag', name: 'Repair' },
        { phrase: 'garage', enabled: true, kind: 'areaType', name: 'Garage' },
        { phrase: 'Garage door', enabled: true, kind: 'item', name: 'Garage door' },
      ]);

      const fix = list[0]!;
      expect(
        (await admin('PATCH', `/api/keyword-rules/${fix.id}`, { enabled: true, phrase: 'fixing' }))
          .statusCode,
      ).toBe(204);
      expect((await admin('DELETE', `/api/keyword-rules/${list[1]!.id}`)).statusCode).toBe(204);
      const after = (await admin('GET', '/api/keyword-rules')).json<{
        rules: { phrase: string; enabled: boolean }[];
      }>().rules;
      expect(after.map((r) => [r.phrase, r.enabled])).toEqual([
        ['fixing', true],
        ['Garage door', true],
      ]);
      expect(
        (await admin('PATCH', '/api/keyword-rules/999999', { enabled: false })).statusCode,
      ).toBe(404);
      expect((await admin('DELETE', '/api/keyword-rules/999999')).statusCode).toBe(404);
    });

    it('requires exactly one valid shared target and a real phrase', async () => {
      const { tag, area } = await ids();
      const admin = client.as(ADMIN);
      await db
        .insertInto('tags')
        .values({ house_id: houseId, slug: 'ours', name: 'Ours' })
        .execute();
      const houseTag = await db
        .selectFrom('tags')
        .select('id')
        .where('slug', '=', 'ours')
        .executeTakeFirstOrThrow();
      for (const body of [
        { phrase: 'x' },
        { phrase: 'x', tagId: tag, areaTypeId: area },
        { phrase: 'x', tagId: 999999 },
        { phrase: 'x', tagId: houseTag.id },
        { phrase: 'x', itemId: 999999 },
        { phrase: ' -- ', tagId: tag },
        { phrase: 'x'.repeat(201), tagId: tag },
      ]) {
        expect(
          (await admin('POST', '/api/keyword-rules', body)).statusCode,
          JSON.stringify(body),
        ).toBe(400);
      }
      await db.deleteFrom('tags').where('house_id', '=', houseId).execute();
    });

    it('queues one apply-rules job at a time, admins only', async () => {
      const first = await client.as(ADMIN)('POST', '/api/keyword-rules/apply');
      expect(first.statusCode).toBe(202);
      const again = await client.as(ADMIN)('POST', '/api/keyword-rules/apply');
      expect(again.json()).toEqual({
        jobId: first.json<{ jobId: number }>().jobId,
        alreadyQueued: true,
      });
      expect((await client.as(OWNER)('POST', '/api/keyword-rules/apply')).statusCode).toBe(403);
      expect((await client.as(OWNER)('GET', '/api/keyword-rules')).statusCode).toBe(403);
    });
  });
});
