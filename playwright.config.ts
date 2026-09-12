import { defineConfig } from '@playwright/test';

const port = 3119;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/admin`,
    env: {
      XHS_BROWSER_TEST_COOKIE: 'local-playwright-admin',
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});