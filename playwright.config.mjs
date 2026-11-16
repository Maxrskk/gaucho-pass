import { defineConfig } from '@playwright/test';

// Browser tests run the real site from a local server. Calls to Supabase are
// answered by the in-memory backend in tests/mock, so no network is needed.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8080',
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tools/serve.mjs 8080',
    url: 'http://localhost:8080/index.html',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'ignore',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
