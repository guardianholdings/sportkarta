import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // The webServer is `next dev`, which compiles each route on its first hit. In a
  // full run that first hit can land mid-test, so a per-test budget tuned for a
  // warm server makes unrelated tests flake on compile latency. 60 s absorbs it
  // without hiding a genuine hang. One local retry (CI already retries) catches
  // the occasional cold-compile stall that still overshoots — the flakiness here
  // is the dev server warming up, not the assertions.
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  // Serial, always. The suite signs in through the real email-OTP flow, and the
  // admin/ambassador tests share one bootstrapped identity (ADMIN_EMAIL in
  // e2e/auth.ts — only ADMIN_EMAILS addresses become admin). Two workers signing
  // in as that same address at once race on its one-time code: one send rotates
  // the other's code and a dozen tests fail with "no sign-in code was delivered".
  // The specs already isolate by using a unique address per *member* test; the
  // shared admin is what cannot run concurrently, so we run one worker. Each spec
  // still passes alone — this only removes the cross-file parallelism.
  workers: 1,
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
      // The dev server compiles the whole app on demand and its heap grows
      // with it. On CI's small runners Next's memory watcher would restart
      // the server mid-suite — and the restart corrupts its own manifest
      // state, 500-ing every page with "Unexpected non-whitespace character
      // after JSON" until nothing passes. Give it room instead.
      NODE_OPTIONS: '--max-old-space-size=4096',
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
