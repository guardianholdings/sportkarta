'use client';

import { useEffect } from 'react';

// Client-side error monitoring to a self-hosted GlitchTip (Sentry-compatible).
// @sentry/browser is imported lazily so its chunk only loads when a DSN is
// configured. Best-effort: monitoring load/init failures never surface to the
// user. Rendered only when a DSN is set (see the [locale] layout).
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
