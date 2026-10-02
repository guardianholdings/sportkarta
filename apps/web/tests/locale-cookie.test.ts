import { describe, expect, it } from 'vitest';

import { routing } from '@/i18n/routing';

/**
 * No NEXT_LOCALE cookie (pre-launch audit: production set one on every visit).
 * With `localeDetection: false` nothing ever reads it, so writing it was
 * undisclosed device storage with no purpose — and /privacy now says the site
 * sets no language cookie and that the only cookies are the sign-in ones.
 *
 * Asserted on the routing object the middleware is built from: next-intl's
 * middleware imports `next/server` without an extension, which plain Node ESM
 * (vitest) cannot resolve, so the response itself is checked end-to-end in
 * e2e/legal.spec.ts instead.
 */
describe('locale cookie', () => {
  it('is switched off, so the middleware never writes one', () => {
    expect(routing.localeCookie).toBe(false);
  });

  it('stays off together with detection — the reason nothing needs it', () => {
    // If detection is ever turned back on, the cookie question must be decided
    // again (and /privacy updated): this pairing is what made it pointless.
    expect(routing.localeDetection).toBe(false);
  });
});
