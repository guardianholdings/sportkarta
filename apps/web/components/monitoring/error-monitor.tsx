'use client';

import { useEffect } from 'react';

import { scrubBreadcrumb, scrubEvent } from '@/lib/client-error-scrub';

// Client-side error monitoring to a self-hosted GlitchTip (Sentry-compatible).
// @sentry/browser is imported lazily so its chunk only loads when a DSN is
// configured. Best-effort: monitoring load/init failures never surface to the
// user. Rendered only when a DSN is set (see the [locale] layout).
//
// What leaves the browser is scrubbed first (lib/client-error-scrub): no
// member, no query string, no invite/unsubscribe/check-in token or passport
// handle in the page URL, the referrer or the request breadcrumbs, and no
// console text — the same promise the server-side reporter keeps.
export function ErrorMonitor({ dsn }: { dsn: string }) {
  useEffect(() => {
    let active = true;
    void import('@sentry/browser')
      .then((Sentry) => {
        if (!active) return;
        Sentry.init({
          dsn,
          tracesSampleRate: 0,
          // Privacy-first: no session replay, no default PII capture.
          sendDefaultPii: false,
          beforeSend: (event) => scrubEvent(event),
          beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
        });
      })
      .catch(() => {
        // Monitoring is best-effort; swallow load/init errors.
      });
    return () => {
      active = false;
    };
  }, [dsn]);

  return null;
}
