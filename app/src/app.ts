import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { AccessDeniedError, ACCESS_JWT_HEADER, type AccessVerifier } from './auth/access.js';
import { ForbiddenError, type Principal } from './auth/policy.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/schema.js';
import { HttpError } from './http/errors.js';
import { healthRoutes } from './routes/health.js';
import { houseRoutes } from './routes/houses.js';
import { importRoutes } from './routes/imports.js';
import { playlistRoutes } from './routes/playlists.js';
import { ruleRoutes } from './routes/rules.js';
import { videoRoutes } from './routes/videos.js';
import { meRoutes } from './routes/me.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for every request except the public health check. */
    principal: Principal;
  }
}

export interface AppDependencies {
  config: Pick<AppConfig, 'publicOrigin' | 'adminEmails' | 'logLevel'>;
  db: Kysely<Database>;
  verifyAccess: AccessVerifier;
  logger?: FastifyServerOptions['logger'];
}

/** Paths reachable without a Cloudflare Access token (used by the Docker health check). */
const PUBLIC_PATHS = new Set(['/healthz']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? {
      level: deps.config.logLevel,
      redact: ['req.headers.cookie', `req.headers["${ACCESS_JWT_HEADER}"]`],
    },
    bodyLimit: 1024 * 1024,
    // Requests arrive from cloudflared; Cloudflare already enforces sane URL lengths.
    routerOptions: { maxParamLength: 200 },
  });

  // Only JSON bodies are accepted. Removing the text/plain parser means a cross-site
  // "simple" form or fetch request can never reach a handler with a parsed body.
  app.removeContentTypeParser('text/plain');

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'img-src': ["'self'", 'https://i.ytimg.com', 'data:'],
        'frame-src': ['https://www.youtube-nocookie.com'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // HSTS is applied by Cloudflare at the edge.
    hsts: false,
    crossOriginEmbedderPolicy: false,
  });

  app.decorateRequest('principal', null as unknown as Principal);

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '';
    if (PUBLIC_PATHS.has(path)) return;

    const header = request.headers[ACCESS_JWT_HEADER];
    const token = Array.isArray(header) ? undefined : header;
    try {
      const identity = await deps.verifyAccess(token);
      request.principal = {
        email: identity.email,
        isAdmin: deps.config.adminEmails.has(identity.email),
      };
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        request.log.warn({ reason: error.message }, 'access denied');
        return reply.code(401).send({ error: 'unauthorized' });
      }
      throw error;
    }

    // CSRF defence: state-changing requests must come from our own origin.
    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin !== deps.config.publicOrigin) {
        request.log.warn({ origin, method: request.method }, 'rejected cross-origin request');
        return reply.code(403).send({ error: 'forbidden', reason: 'origin' });
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ForbiddenError) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(500).send({ error: 'internal_error' });
    }
    // 4xx from Fastify itself (validation, unsupported media type, body too large, …).
    return reply.code(statusCode).send({
      error: 'bad_request',
      message: error instanceof Error ? error.message : 'Bad request',
    });
  });

  await app.register(healthRoutes, { db: deps.db });
  await app.register(meRoutes, { db: deps.db });
  await app.register(houseRoutes, { db: deps.db });
  await app.register(importRoutes, { db: deps.db });
  await app.register(playlistRoutes, { db: deps.db });
  await app.register(ruleRoutes, { db: deps.db });
  await app.register(videoRoutes, { db: deps.db });

  return app;
}
