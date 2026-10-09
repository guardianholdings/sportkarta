import { randomBytes } from 'node:crypto';

import { defineConfig, devices } from '@playwright/test';
import { config as loadDotenv } from 'dotenv';

/**
 * Which server the suite drives, and where sign-in codes go.
 *
 * WITH E2E_MAILPIT_URL (CI, .github/workflows/e2e.yml): the PRODUCTION server —
 * `next start` over the build the workflow made in an earlier step, which is
 * how production runs. `next start` is NODE_ENV=production, where
 * resolveMailTransport refuses the file outbox on purpose (a one-time code must
 * never land in a log or a file), so codes go over real SMTP to a mailpit sink
 * and e2e/auth.ts reads them back from its API.
 *
 * WITHOUT it (a local run): `next dev` and the file outbox, as before.
 *
 * Why CI moved off `next dev` (2026-09): its memory watcher restarted the
 * server mid-suite on the small runners, the restart corrupted its manifests,
 * every page then 500-ed with a JSON parse error, and every E2E run from
 * 2026-08-09 on hit the job timeout and was cancelled — no signal at all.
 */
const MAILPIT_URL = process.env.E2E_MAILPIT_URL?.trim();

// Every browser in the suite shares one IP, the admin tests share one address,
// and a full run mails a few dozen codes — locally, with a reused server, more
// than one run's worth inside the site-wide hourly breaker's window.
const RATE_LIMITS = {
  OTP_RATE_LIMIT_IP: process.env.OTP_RATE_LIMIT_IP ?? '200',
  OTP_RATE_LIMIT_EMAIL: process.env.OTP_RATE_LIMIT_EMAIL ?? '50',
  OTP_SEND_LIMIT_PER_HOUR: process.env.OTP_SEND_LIMIT_PER_HOUR ?? '1000',
};

// B0 diagnostic (draft PR only): E2E_STANDALONE runs the server the way the
// Docker image does — `node apps/web/server.js` on HOSTNAME=0.0.0.0 — instead
// of `next start`, which warns that it does not support output: standalone.
// The standalone server never runs next.config.ts, which is what loads the
// repo-root .env for `next start`; production gets its environment from
// compose instead. So the same values are handed over here, through this
// process's environment (dotenv never overrides a value already set).
const standalone = Boolean(process.env.E2E_STANDALONE);
if (standalone) loadDotenv({ path: '../../.env' });

const productionServer = {
  command: standalone ? 'node .next/standalone/apps/web/server.js' : 'pnpm start',
  url: 'http://localhost:3000',
  reuseExistingServer: !process.env.CI,
  // A built server boots in seconds; the build itself is a workflow step.
  timeout: 60_000,
  env: {
    ...(standalone ? { HOSTNAME: '0.0.0.0', PORT: '3000' } : {}),
    // Production refuses the development fallback secret and the published
    // placeholder (lib/auth-config.ts). A throwaway per run: sessions only have
    // to outlive the suite.
    AUTH_SECRET: randomBytes(32).toString('hex'),
    MAIL_TRANSPORT: 'smtp',
    // The loopback ADDRESS rather than "localhost", which may resolve to ::1
    // first; the sink's certificate names 127.0.0.1, so TLS still verifies.
    SMTP_HOST: process.env.E2E_SMTP_HOST ?? '127.0.0.1',
    SMTP_PORT: process.env.E2E_SMTP_PORT ?? '1025',
    // Explicitly empty: a developer's real relay credentials in .env must
    // never be presented to the sink (dotenv does not override a set value).
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM: 'POPS e2e <no-reply@example.org>',
    ...RATE_LIMITS,
  },
};

const devServer = {
  command: 'pnpm dev',
  url: 'http://localhost:3000',
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: {
    // The dev server compiles the whole app on demand and its heap grows with
    // it; give it room so Next's memory watcher does not restart it mid-run.
    NODE_OPTIONS: '--max-old-space-size=4096',
    // The suite reads sign-in codes from the file outbox (e2e/auth.ts). Pinned
    // here rather than left to .env: a developer with a real SMTP relay
    // configured would otherwise send a dozen live emails per run.
    MAIL_TRANSPORT: 'file',
    MAIL_OUTBOX_DIR: process.env.MAIL_OUTBOX_DIR ?? './var/mail',
    ...RATE_LIMITS,
  },
};

export default defineConfig({
  testDir: './e2e',
  // 60 s absorbs a `next dev` cold compile landing mid-test without hiding a
  // genuine hang; against the production server it is simply headroom.
  timeout: 60_000,
  // The whole run, in CI: well inside the job's timeout-minutes, so an overrun
  // ends here — with a report and traces — instead of as a cancelled job that
  // leaves nothing behind (every cancelled run before 2026-09 did exactly that).
  globalTimeout: process.env.CI ? 18 * 60_000 : 0,
  // If sign-in itself breaks, every test fails the same way; stop early rather
  // than spend the budget proving it sixty times.
  maxFailures: process.env.CI ? 12 : 0,
  forbidOnly: !!process.env.CI,
  // One retry everywhere: it catches a genuine one-off (a slow first compile
  // under `next dev`) and marks the test flaky in the report instead of hiding
  // it. More would triple the cost of a real failure.
  retries: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
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
    // The production build registers the PWA service worker (public/sw.js),
    // which answers navigations itself — page.goto() then reports no network
    // response and the status assertions read nothing. It is not under test.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // B0 diagnostic (draft PR only): the Safari engine, for that spec alone.
    ...(process.env.E2E_WEBKIT
      ? [
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
            testMatch: /b0-add-diagnostic\.spec\.ts/,
          },
        ]
      : []),
  ],
  webServer: MAILPIT_URL ? productionServer : devServer,
});
