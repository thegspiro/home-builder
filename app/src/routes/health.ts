import type { FastifyPluginCallback } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

export const healthRoutes: FastifyPluginCallback<{ db: Kysely<Database> }> = (
  app,
  { db },
  done,
) => {
  // Public (no Access token) so the container health check can reach it. Reports only
  // up/down: no versions, counts or error details.
  // Logged at warn so the 30-second container health check doesn't flood the logs.
  app.get('/healthz', { logLevel: 'warn' }, async (request, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
      return { status: 'ok' };
    } catch (error) {
      request.log.error({ err: error }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  done();
};
