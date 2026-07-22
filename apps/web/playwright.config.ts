import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // The suite reads sign-in codes from the file outbox (e2e/auth.ts). Pinned
      // here rather than left to .env: a developer with a real SMTP relay
      // configured would otherwise send a dozen live emails per run.
      MAIL_TRANSPORT: 'file',
      MAIL_OUTBOX_DIR: process.env.MAIL_OUTBOX_DIR ?? './var/mail',
      // Every browser in the suite shares one address and one IP.
      OTP_RATE_LIMIT_IP: process.env.OTP_RATE_LIMIT_IP ?? '200',
      OTP_RATE_LIMIT_EMAIL: process.env.OTP_RATE_LIMIT_EMAIL ?? '50',
      OTP_RATE_LIMIT_PER_MINUTE: process.env.OTP_RATE_LIMIT_PER_MINUTE ?? '100',
    },
  },
});
