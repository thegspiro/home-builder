/**
 * Imports and job status (docs/JOBS.md).
 *
 *   POST /api/imports/paste   {text, houseId?}   pasted URLs, one per line (max 500)
 *   POST /api/imports/csv     {csv, houseId?}    Google Takeout playlist CSV
 *   GET  /api/jobs?houseId=                       recent jobs in a scope
 *   GET  /api/jobs/:jobId                         one job's status and result
 *
 * Without houseId these feed the shared library (global admins). With houseId they add
 * videos private to that house (owners and editors).
 */
import type { FastifyPluginCallback } from 'fastify';
import type { Kysely } from 'kysely';
import { assertCan } from '../auth/policy.js';
import type { Database } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { requireHouse, requireScope } from '../houses/access.js';
import { enqueueJob, getJob, listJobs } from '../jobs/service.js';
import { ID } from './schemas.js';

/** Matches the worker's MAX_INPUT_CHARS. */
const MAX_CSV_CHARS = 2_000_000;
const MAX_PASTE_CHARS = 200_000;
const MAX_PASTE_LINES = 500;

export const importRoutes: FastifyPluginCallback<{ db: Kysely<Database> }> = (
  app,
  { db },
  done,
) => {
  app.post<{ Body: { text: string; houseId?: number } }>(
    '/api/imports/paste',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: MAX_PASTE_CHARS },
            houseId: ID,
          },
        },
      },
    },
    async (request, reply) => {
      const houseId = await requireScope(
        db,
        request.principal,
        request.body.houseId,
        'house.videos.edit',
      );
      const lines = request.body.text.split(/\r?\n/).filter((l) => l.trim() !== '');
      if (lines.length > MAX_PASTE_LINES) {
        throw new ValidationError(`Paste at most ${MAX_PASTE_LINES} lines at a time`);
      }
      const jobId = await enqueueJob(db, request.principal, houseId, {
        type: 'paste_import',
        payload: { text: request.body.text },
      });
      return reply.code(202).send({ jobId });
    },
  );

  app.post<{ Body: { csv: string; houseId?: number } }>(
    '/api/imports/csv',
    {
      bodyLimit: MAX_CSV_CHARS * 2 + 1024,
      schema: {
        body: {
          type: 'object',
          required: ['csv'],
          additionalProperties: false,
          properties: {
            csv: { type: 'string', minLength: 1, maxLength: MAX_CSV_CHARS },
            houseId: ID,
          },
        },
      },
    },
    async (request, reply) => {
      const houseId = await requireScope(
        db,
        request.principal,
        request.body.houseId,
        'house.videos.edit',
      );
      const jobId = await enqueueJob(db, request.principal, houseId, {
        type: 'csv_import',
        payload: { csv: request.body.csv },
      });
      return reply.code(202).send({ jobId });
    },
  );

  app.get<{ Querystring: { houseId?: number } }>(
    '/api/jobs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { houseId: ID },
        },
      },
    },
    async (request) => {
      const { houseId } = request.query;
      if (houseId === undefined) {
        assertCan(request.principal, 'library.edit');
      } else {
        await requireHouse(db, request.principal, houseId, 'house.view');
      }
      return { jobs: await listJobs(db, houseId ?? null) };
    },
  );

  app.get<{ Params: { jobId: number } }>(
    '/api/jobs/:jobId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['jobId'],
          properties: { jobId: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const job = await getJob(db, request.params.jobId);
      if (!job) throw new NotFoundError('Job');
      if (job.houseId === null) {
        // Shared-library jobs are admin business; others see "not found".
        if (!request.principal.isAdmin) throw new NotFoundError('Job');
      } else {
        await requireHouse(db, request.principal, job.houseId, 'house.view');
      }
      return job;
    },
  );

  done();
};
