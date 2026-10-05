import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Runtime configuration, read from environment variables only.
 * Invalid or missing required values fail fast at startup with a clear message.
 */

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
}

export interface AccessConfig {
  /** Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com". */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  audience: string;
}

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  /** Origin the browser uses to reach the app, e.g. "https://videos.example.com". */
  publicOrigin: string;
  adminEmails: ReadonlySet<string>;
  access: AccessConfig;
  database: DatabaseConfig;
  /** Directory with the built web pages (web/dist), or null to serve the API only. */
  webRoot: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const TEAM_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_RE = /^[A-Za-z0-9]{16,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function integer(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseAdminEmails(raw: string): Set<string> {
  const emails = new Set<string>();
  for (const part of raw.split(',')) {
    const email = normalizeEmail(part);
    if (!email) continue;
    if (!EMAIL_RE.test(email)) {
      throw new ConfigError(`ADMIN_EMAILS contains an invalid email: "${email}"`);
    }
    emails.add(email);
  }
  return emails;
}

function parseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_ORIGIN must be a URL like https://videos.example.com`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('PUBLIC_ORIGIN must use http or https');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('PUBLIC_ORIGIN must not include a path, query or fragment');
  }
  return url.origin;
}

function parseWebRoot(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!isAbsolute(value)) throw new ConfigError('WEB_ROOT must be an absolute path');
  if (!existsSync(join(value, 'index.html'))) {
    throw new ConfigError(`WEB_ROOT has no index.html: ${value}`);
  }
  return value;
}

export function loadDatabaseConfig(env: Env = process.env): DatabaseConfig {
  return {
    host: required(env, 'DATABASE_HOST'),
    port: integer('DATABASE_PORT', optional(env, 'DATABASE_PORT', '3306'), 1, 65535),
    database: required(env, 'DATABASE_NAME'),
    user: required(env, 'DATABASE_USER'),
    password: required(env, 'DATABASE_PASSWORD'),
    connectionLimit: integer(
      'DATABASE_CONNECTION_LIMIT',
      optional(env, 'DATABASE_CONNECTION_LIMIT', '10'),
      1,
      200,
    ),
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const teamDomain = required(env, 'CF_ACCESS_TEAM_DOMAIN').toLowerCase();
  if (!TEAM_DOMAIN_RE.test(teamDomain)) {
    throw new ConfigError(
      'CF_ACCESS_TEAM_DOMAIN must look like "<team>.cloudflareaccess.com" (no https://)',
    );
  }
  const audience = required(env, 'CF_ACCESS_AUD');
  if (!AUD_RE.test(audience)) {
    throw new ConfigError('CF_ACCESS_AUD must be the Access application AUD tag');
  }

  const logLevel = optional(env, 'LOG_LEVEL', 'info');
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}`);
  }

  return {
    host: optional(env, 'HOST', '0.0.0.0'),
    port: integer('PORT', optional(env, 'PORT', '8080'), 1, 65535),
    webRoot: parseWebRoot(env['WEB_ROOT']),
    logLevel,
    publicOrigin: parseOrigin(required(env, 'PUBLIC_ORIGIN')),
    adminEmails: parseAdminEmails(optional(env, 'ADMIN_EMAILS', '')),
    access: { teamDomain, audience },
    database: loadDatabaseConfig(env),
  };
}
