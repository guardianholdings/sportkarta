/**
 * Hand an error that an error BOUNDARY caught to GlitchTip.
 *
 * Before app/[locale]/error.tsx existed, a render error went uncaught and
 * reached the window error handler the SDK listens on (error-monitor.tsx). A
 * boundary that catches it ends that journey — the screen recovers and the
 * report silently stops — so each boundary forwards it here instead.
 *
 * Only when monitoring is actually running: with no DSN the SDK was never
 * initialised, there is no client, and this sends nothing. Best-effort like
 * the monitor itself; a failure to load or send never reaches the visitor.
 */
export function reportCaughtError(error: Error): void {
  void import('@sentry/browser')
    .then((Sentry) => {
      if (Sentry.getClient()) Sentry.captureException(error);
    })
    .catch(() => {
      // Monitoring is best-effort.
    });
}
