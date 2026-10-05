import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './test/e2e/config.js';

/**
 * Browser tests of the real pages against the real API and a disposable MySQL database
 * (DATABASE_* env vars, name must contain "test"). Build the pages first:
 *   (cd ../web && npm run build)
 * PW_CHROMIUM_EXECUTABLE points at an already-installed Chromium if Playwright's own
 * browser download is unavailable.
 */
export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  webServer: {
    // A separate process: Playwright's loader can't require() the ESM-only
    // dependencies of @fastify/static, and it is closer to production anyway.
    command: 'npx tsx test/e2e/serve.ts',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    launchOptions: process.env['PW_CHROMIUM_EXECUTABLE']
      ? { executablePath: process.env['PW_CHROMIUM_EXECUTABLE'] }
      : {},
  },
});
