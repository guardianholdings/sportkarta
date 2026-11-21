'use client';

import { useEffect } from 'react';

import { scrubBreadcrumb, scrubEvent } from '@/lib/client-error-scrub';

/** The most early errors kept for the SDK; a page that throws more is one report. */
const EARLY_LIMIT = 10;
/** How long after the page has loaded the SDK is fetched if nobody touches the page. */
const QUIET_MS = 8000;

// Client-side error monitoring to a self-hosted GlitchTip (Sentry-compatible).
// Best-effort: monitoring load/init failures never surface to the user.
// Rendered only when a DSN is set (see the [locale] layout).
//
// AFTER THE PAGE, NOT WITH IT. The SDK is 146 KB over the wire, and PageSpeed
// found 126 KB of it unused during the load and its parse among the load's
// long tasks (2026-11-16) — a visitor on a phone paid for the monitor before
// they could use the page it monitors. So it is fetched on the first sign of
// a person (a touch, a key, a scroll) or, failing that, once the page has
// been loaded and quiet for a few seconds.
//
// Nothing is lost in the gap: two listeners, a few lines, are on from the
// first effect and keep what is thrown until the SDK is in, which then
// reports them like any other. They are kept in memory only and go through
// the same scrubbing as everything else.
//
// What leaves the browser is scrubbed first (lib/client-error-scrub): no
// member, no query string, no invite/unsubscribe/check-in token or passport
// handle in the page URL, the referrer or the request breadcrumbs, and no
// console text — the same promise the server-side reporter keeps.
export function ErrorMonitor({ dsn }: { dsn: string }) {
  useEffect(() => {
    let active = true;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early: unknown[] = [];

    const keepError = (event: ErrorEvent) => {
      if (early.length < EARLY_LIMIT) early.push(event.error ?? new Error(event.message));
    };
    const keepRejection = (event: PromiseRejectionEvent) => {
      if (early.length < EARLY_LIMIT) early.push(event.reason);
    };
    const stopKeeping = () => {
      window.removeEventListener('error', keepError);
      window.removeEventListener('unhandledrejection', keepRejection);
    };

    const SIGNS = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    const stopWaiting = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('load', whenLoaded);
      for (const sign of SIGNS) window.removeEventListener(sign, start);
    };

    function start() {
      if (started) return;
      started = true;
      stopWaiting();
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
          // The SDK has its own listeners now; hand it what was kept.
          stopKeeping();
          for (const error of early.splice(0)) Sentry.captureException(error);
        })
        .catch(() => {
          // Monitoring is best-effort; swallow load/init errors.
          stopKeeping();
        });
    }

    function whenLoaded() {
      timer = setTimeout(start, QUIET_MS);
    }

    window.addEventListener('error', keepError);
    window.addEventListener('unhandledrejection', keepRejection);
    for (const sign of SIGNS) window.addEventListener(sign, start, { once: true, passive: true });
    if (document.readyState === 'complete') whenLoaded();
    else window.addEventListener('load', whenLoaded, { once: true });

    return () => {
      active = false;
      stopWaiting();
      stopKeeping();
    };
  }, [dsn]);

  return null;
}
