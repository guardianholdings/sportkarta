import { createErrorReporter } from '@sportkarta/lib/error-report';
import type { Instrumentation } from 'next';

/**
 * Server-side error capture (pre-launch audit finding 57).
 *
 * ErrorMonitor only ever initialised @sentry/browser, so an exception in a
 * server component, a route handler or a server action — the places a member
 * actually hits a 500 — reached nobody. Next calls `onRequestError` for exactly
 * those (not for notFound()/redirect(), which it filters out first), and this
 * forwards each one to GlitchTip when GLITCHTIP_DSN is set. Unset, it is a
 * no-op and nothing is built.
 *
 * WHAT GOES OUT IS CHOSEN, NOT CAPTURED. The request's headers (cookies,
 * session, forwarded IP) and its concrete path (which can carry an account id,
 * a share handle or a calendar token) are deliberately never read: the event
 * names the route TEMPLATE, the method and the kind of render, and the error
 * message and stack pass through the shared scrubber
 * (lib/src/error-report). `digest` is the id Next shows on the error page, so
 * an operator can match a member's screenshot to the event.
 */
const reporter = createErrorReporter({
  dsn: process.env.GLITCHTIP_DSN,
  component: 'web',
  environment: process.env.NODE_ENV,
});

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error
      ? String((error as { digest: unknown }).digest)
      : undefined;
  await reporter.captureException(error, {
    transaction: context.routePath,
    tags: {
      method: request.method,
      routeType: context.routeType,
      routerKind: context.routerKind,
      renderSource: context.renderSource,
      runtime: process.env.NEXT_RUNTIME,
    },
    extra: { digest },
  });
};
