import type { Breadcrumb, ErrorEvent } from '@sentry/browser';

import { scrubTokenisedPath } from './tokenised-paths';

/**
 * What a browser error report may carry to GlitchTip.
 *
 * The server reporter (lib/src/error-report) sends the route template and a
 * scrubbed message. The browser SDK, left to its defaults, sends the concrete
 * address of the page (an invite, an unsubscribe link, a check-in token, a
 * passport handle), the referrer, every fetch URL as a breadcrumb and whatever
 * the console printed — the exact material /privacy says the error service
 * does not receive. These two hooks make the browser side keep the same
 * promise: no person, no token, no query string, no console text.
 *
 * Pure functions, so tests/client-error-scrub.test.ts can run them without a
 * browser; components/monitoring/error-monitor.tsx wires them into the SDK.
 */

const URL_KEYS = ['url', 'to', 'from'] as const;

/** Drops the query and fragment, then any tokenised path segment. */
export function scrubUrl(value: string): string {
  return scrubTokenisedPath(value.replace(/[?#].*$/, ''));
}

/** Free text: addresses, query strings, IPs, long hex tokens, phone-like digits. */
export function scrubText(value: string): string {
  return scrubTokenisedPath(
    value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/(\/[^\s?#"'`]*)\?[^\s"'`]*/g, '$1?[query]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
      .replace(/\b[a-f0-9]{32,}\b/gi, '[token]')
      .replace(/(^|[^\w-])\+?\d[\d ]{7,}\d(?![\w-])/g, '$1[number]'),
  );
}

/**
 * `beforeBreadcrumb`: console lines are dropped whole (they can hold anything a
 * component logged); navigation and request crumbs keep only scrubbed URLs.
 */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === 'console') return null;
  const data: Record<string, unknown> = { ...(crumb.data ?? {}) };
  for (const key of URL_KEYS) {
    const value = data[key];
    if (typeof value === 'string') data[key] = scrubUrl(value);
  }
  // Request bodies, response bodies and headers are never part of a report.
  delete data.body;
  delete data.response;
  delete data.headers;
  delete data.request_body_size;
  delete data.response_body_size;
  return {
    ...crumb,
    ...(crumb.message === undefined ? {} : { message: scrubText(crumb.message) }),
    data,
  };
}

/** `beforeSend`: the event minus the person, with every address and message scrubbed. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const out: ErrorEvent = { ...event };
  // The member is never identified in an error report (sendDefaultPii is off
  // too; this covers anything a future call to setUser would add).
  delete out.user;
  delete out.extra;
  if (out.request) {
    const request = { ...out.request };
    if (request.url) request.url = scrubUrl(request.url);
    if (request.headers) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value !== 'string') continue;
        const lower = name.toLowerCase();
        if (lower === 'cookie' || lower === 'authorization') continue;
        headers[name] = lower === 'referer' ? scrubUrl(value) : value;
      }
      request.headers = headers;
    }
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    out.request = request;
  }
  if (out.transaction) out.transaction = scrubUrl(out.transaction);
  if (out.message) out.message = scrubText(out.message);
  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((value) =>
        value.value === undefined ? value : { ...value, value: scrubText(value.value) },
      ),
    };
  }
  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((crumb): crumb is Breadcrumb => crumb !== null);
  }
  return out;
}
