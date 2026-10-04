import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import type { DatabaseConfig } from '../config.js';
import type { Database } from './schema.js';

export function createDb(config: DatabaseConfig): Kysely<Database> {
  const pool = createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionLimit: config.connectionLimit,
    charset: 'utf8mb4',
    timezone: 'Z',
    // Never allow multiple statements per query: limits the blast radius of any injection.
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  return new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });
}
