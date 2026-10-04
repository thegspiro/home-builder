import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadDatabaseConfig, parseAdminEmails } from '../../src/config.js';

const VALID_ENV = {
  CF_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com',
  CF_ACCESS_AUD: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  PUBLIC_ORIGIN: 'https://videos.example.com',
  ADMIN_EMAILS: 'Owner@Example.com, second@example.com',
  DATABASE_HOST: 'db',
  DATABASE_NAME: 'homebuilder',
  DATABASE_USER: 'homebuilder',
  DATABASE_PASSWORD: 'secret',
};

describe('loadConfig', () => {
  it('parses a complete environment with defaults', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('info');
    expect(config.publicOrigin).toBe('https://videos.example.com');
    expect([...config.adminEmails]).toEqual(['owner@example.com', 'second@example.com']);
    expect(config.access).toEqual({
      teamDomain: 'myteam.cloudflareaccess.com',
      audience: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    });
    expect(config.database).toMatchObject({ host: 'db', port: 3306, connectionLimit: 10 });
  });

  it.each([
    'CF_ACCESS_TEAM_DOMAIN',
    'CF_ACCESS_AUD',
    'PUBLIC_ORIGIN',
    'DATABASE_HOST',
    'DATABASE_NAME',
    'DATABASE_USER',
    'DATABASE_PASSWORD',
  ])('fails when %s is missing', (name) => {
    const env: Record<string, string | undefined> = { ...VALID_ENV, [name]: undefined };
    expect(() => loadConfig(env)).toThrow(
      new ConfigError(`Missing required environment variable ${name}`),
    );
  });

  it.each([
    ['CF_ACCESS_TEAM_DOMAIN', 'https://myteam.cloudflareaccess.com'],
    ['CF_ACCESS_TEAM_DOMAIN', 'myteam.example.com'],
    ['CF_ACCESS_AUD', 'short'],
    ['PUBLIC_ORIGIN', 'videos.example.com'],
    ['PUBLIC_ORIGIN', 'https://videos.example.com/app'],
    ['PUBLIC_ORIGIN', 'ftp://videos.example.com'],
    ['PORT', '0'],
    ['PORT', '80a'],
    ['DATABASE_PORT', '70000'],
    ['LOG_LEVEL', 'loud'],
    ['ADMIN_EMAILS', 'not-an-email'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => loadConfig({ ...VALID_ENV, [name]: value })).toThrow(ConfigError);
  });

  it('normalizes PUBLIC_ORIGIN with a trailing slash', () => {
    expect(
      loadConfig({ ...VALID_ENV, PUBLIC_ORIGIN: 'https://videos.example.com/' }).publicOrigin,
    ).toBe('https://videos.example.com');
  });

  it('loads database config without Access settings', () => {
    const { DATABASE_HOST, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD } = VALID_ENV;
    expect(
      loadDatabaseConfig({ DATABASE_HOST, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD }),
    ).toMatchObject({ host: 'db', database: 'homebuilder' });
  });
});

describe('parseAdminEmails', () => {
  it('ignores blanks and duplicates, lowercases', () => {
    expect([...parseAdminEmails(' A@x.io,, a@X.io ,b@x.io ')]).toEqual(['a@x.io', 'b@x.io']);
  });

  it('returns an empty set for an empty string', () => {
    expect(parseAdminEmails('').size).toBe(0);
  });
});
