/**
 * YouTube playlists synced into the shared library (global admins).
 *
 *   GET    /api/playlists
 *   POST   /api/playlists                {url}   URL or bare playlist ID; queues a first sync
 *   DELETE /api/playlists/:playlistId           stops syncing; imported videos stay
 *   POST   /api/playlists/:playlistId/sync      "Sync now"
 */
import type { FastifyPluginCallback } from 'fastify';
import type { Kysely } from 'kysely';
import { writeAudit } from '../audit.js';
import { assertCan } from '../auth/policy.js';
import type { Database } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { enqueueJob, findActiveJob } from '../jobs/service.js';
import { parsePlaylistId } from '../youtube.js';
import { ID } from './schemas.js';

const playlistParams = {
  type: 'object',
  required: ['playlistId'],
  properties: { playlistId: ID },
} as const;

export const playlistRoutes: FastifyPluginCallback<{ db: Kysely<Database> }> = (
  app,
  { db },
  done,
) => {
  app.get('/api/playlists', async (request) => {
    assertCan(request.principal, 'library.edit');
    const rows = await db
      .selectFrom('playlists')
      .select(['id', 'youtube_playlist_id', 'title', 'last_synced_at', 'created_at'])
      .orderBy('id')
      .execute();
    return {
      playlists: rows.map((r) => ({
        id: r.id,
        youtubePlaylistId: r.youtube_playlist_id,
        title: r.title,
        lastSyncedAt: r.last_synced_at,
        createdAt: r.created_at,
      })),
    };
  });

  app.post<{ Body: { url: string } }>(
    '/api/playlists',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          additionalProperties: false,
          properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
        },
      },
    },
    async (request, reply) => {
      assertCan(request.principal, 'library.edit');
      const youtubeId = parsePlaylistId(request.body.url);
      if (!youtubeId) throw new ValidationError('Not a YouTube playlist URL or ID');

      const existing = await db
        .selectFrom('playlists')
        .select('id')
        .where('youtube_playlist_id', '=', youtubeId)
        .executeTakeFirst();
      if (existing) throw new ConflictError('That playlist is already being synced');

      const id = await db.transaction().execute(async (trx) => {
        const result = await trx
          .insertInto('playlists')
          .values({ youtube_playlist_id: youtubeId })
          .executeTakeFirstOrThrow();
        const playlistId = Number(result.insertId);
        await writeAudit(trx, {
          actorEmail: request.principal.email,
          houseId: null,
          action: 'playlist.add',
          entity: 'playlist',
          entityId: playlistId,
          details: { youtubePlaylistId: youtubeId },
        });
        return playlistId;
      });
      const jobId = await enqueueJob(db, request.principal, null, {
        type: 'playlist_sync',
        payload: { playlistId: id },
      });
      return reply.code(201).send({ id, youtubePlaylistId: youtubeId, jobId });
    },
  );

  app.delete<{ Params: { playlistId: number } }>(
    '/api/playlists/:playlistId',
    { schema: { params: playlistParams } },
    async (request, reply) => {
      assertCan(request.principal, 'library.edit');
      const { playlistId } = request.params;
      await db.transaction().execute(async (trx) => {
        const removed = await trx
          .deleteFrom('playlists')
          .where('id', '=', playlistId)
          .executeTakeFirst();
        if (Number(removed.numDeletedRows) === 0) throw new NotFoundError('Playlist');
        await writeAudit(trx, {
          actorEmail: request.principal.email,
          houseId: null,
          action: 'playlist.remove',
          entity: 'playlist',
          entityId: playlistId,
        });
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { playlistId: number } }>(
    '/api/playlists/:playlistId/sync',
    { schema: { params: playlistParams } },
    async (request, reply) => {
      assertCan(request.principal, 'library.edit');
      const { playlistId } = request.params;
      const playlist = await db
        .selectFrom('playlists')
        .select('id')
        .where('id', '=', playlistId)
        .executeTakeFirst();
      if (!playlist) throw new NotFoundError('Playlist');

      const active = await findActiveJob(db, 'playlist_sync', {
        key: 'playlistId',
        value: playlistId,
      });
      if (active !== null) return reply.code(202).send({ jobId: active, alreadyQueued: true });
      const jobId = await enqueueJob(db, request.principal, null, {
        type: 'playlist_sync',
        payload: { playlistId },
      });
      return reply.code(202).send({ jobId, alreadyQueued: false });
    },
  );

  done();
};
