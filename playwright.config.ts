import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 35000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node --import tsx scripts/dev.ts --demo',
    env: { CMD_F_TEST_PROVIDER: 'mock' },
    url: 'http://127.0.0.1:4317/healthz',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
