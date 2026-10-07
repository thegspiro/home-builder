import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ADMIN = 'admin@example.com';
export const E2E_PORT = Number(process.env['E2E_PORT'] ?? 4319);
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_STATE_FILE =
  process.env['E2E_STATE_FILE'] ?? join(tmpdir(), `home-builder-e2e-${E2E_PORT}.json`);
