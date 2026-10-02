/**
 * Server-side error reporting to the self-hosted GlitchTip (Sentry-compatible).
 *
 * WHY NOT AN SDK. The browser already runs @sentry/browser (ErrorMonitor), but
 * the server side — Next's `onRequestError` hook and the pg-boss worker — needs
 * exactly one thing: POST a scrubbed event to an envelope endpoint. An SDK would
 * add auto-instrumentation, request capture and breadcrumbs, and every one of
 * those is a way for a cookie, an address or a query string to leave the box.
 * This module can only send what it is handed, after scrubbing it.
 *
 * A NO-OP WITHOUT A DSN. `GLITCHTIP_DSN` is empty in every environment until the
 * operator creates a GlitchTip project; with no DSN nothing is built and
 * `fetch` is never called, so local development and CI are unaffected.
 *
 * NEVER THROWS. Reporting an error must not become a second error: a
 * GlitchTip that is down, slow or misconfigured costs one bounded request and a
 * `false`, never an exception in the code path that was already failing.
 *
 * WHAT IS NEVER SENT: request headers, cookies, query strings, bodies, the
 * concrete request path (only the route TEMPLATE, e.g. `/[locale]/obekt/[slug]`),
 * user ids, IP addresses, a failed query's bound parameters. Free text that does
 * go out — an error message, a stack — passes through `scrubText` first, because
 * drizzle prints every bound value into its error message, a Postgres error can
 * quote a row value and a pg connection error can quote the connection string.
 *
 * No Node-only imports: Next compiles instrumentation for the edge runtime as
 * well, so this file uses only `fetch` and `globalThis.crypto`.
 */

export interface Dsn {
  /** `https://glitchtip.example.org` — scheme, host and port. */
  origin: string;
  /** Any path in front of the project id (usually empty). */
  pathPrefix: string;
  projectId: string;
  publicKey: string;
}

/** Parse a Sentry-style DSN. Anything malformed is `null`, i.e. "reporting off". */
export function parseDsn(raw: string | null | undefined): Dsn | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const publicKey = decodeURIComponent(url.username);
  if (!publicKey) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!projectId || !/^\d+$/.test(projectId)) return null;
  return {
    origin: `${url.protocol}//${url.host}`,
    pathPrefix: segments.length > 0 ? `/${segments.join('/')}` : '',
    projectId,
    publicKey,
  };
}

export function envelopeUrl(dsn: Dsn): string {
  return `${dsn.origin}${dsn.pathPrefix}/api/${dsn.projectId}/envelope/`;
}

const MAX_TEXT = 2000;

/**
 * A FAILED QUERY'S BOUND VALUES. drizzle-orm's DrizzleQueryError — what every
 * failed `db.execute` throws — has the message `Failed query: <sql>\nparams:
 * <every bound value>`: display names, free-text report and training bodies,
 * account ids, and the browser coordinates that verify, condition-report and
 * check-in bind precisely so that only `distance_m` is ever stored. None of the
 * patterns below would catch a name or a latitude, so everything from `params:`
 * on is dropped — the values can contain anything, newlines included, so there
 * is no "end of the parameters" to stop at. The SQL before it is ours, with
 * placeholders, and stays.
 */
const QUERY_PARAMS = /\n\s*params:[\s\S]*$/;

/**
 * Remove what could identify a person or open a door, from free text.
 *
 * Deliberately blunt: it is applied to error messages and stack frames, where a
 * false positive costs a little debugging context and a false negative puts an
 * address into a third system. Order matters — a query's parameters go first
 * (they can hold anything), and credentials inside a URL are removed before the
 * URL's query string is.
 */
export function scrubText(input: string): string {
  return (
    input
      .replace(QUERY_PARAMS, '\nparams: [redacted]')
      // user:password@ inside any URL-ish string (postgres://, smtp+tls://, https://).
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1[redacted]@')
      // E-mail addresses.
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      // Query strings and fragments: tokens, calendar keys, share handles.
      .replace(/(\/[^\s?#"'`]*)\?[^\s"'`]*/g, '$1?[query]')
      // IPv4 addresses.
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
      // Long hex runs: API keys, session and calendar tokens, hashes.
      .replace(/\b[a-f0-9]{32,}\b/gi, '[token]')
      // Phone-number-like digit runs — but not a group inside a UUID or a
      // longer identifier, hence the look-arounds.
      .replace(/(?<![\w-])\+?\d[\d ]{7,}\d(?![\w-])/g, '[number]')
      .slice(0, MAX_TEXT)
  );
}

export interface StackFrame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * V8 stack text to Sentry frames, OUTERMOST FIRST (the order the protocol
 * expects, and the reverse of how V8 prints them). Unparseable lines are
 * dropped rather than guessed at.
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n').slice(0, 60)) {
    const match = V8_FRAME.exec(line);
    if (!match) continue;
    const [, fn, file, lineno, colno] = match;
    const filename = scrubText(file ?? '');
    frames.push({
      ...(fn ? { function: scrubText(fn) } : {}),
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.reverse();
}

/** Tag and extra values: primitives only, strings scrubbed and short. */
export type ReportContext = Record<string, string | number | boolean | null | undefined>;

function cleanContext(
  context: ReportContext | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(context ?? {})) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'string' ? scrubText(value).slice(0, 200) : value;
  }
  return out;
}

export interface ReporterOptions {
  dsn: string | null | undefined;
  /** Which process is reporting — `web`, `worker`. Sent as a tag. */
  component: string;
  environment?: string | undefined;
  release?: string | undefined;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests. */
  now?: () => number;
  /** Events per rolling minute before the reporter goes quiet. */
  maxPerMinute?: number;
  timeoutMs?: number;
}

export interface ErrorEvent {
  event_id: string;
  timestamp: number;
  platform: 'node';
  level: 'error' | 'warning';
  environment?: string;
  release?: string;
  transaction?: string;
  tags: Record<string, string | number | boolean>;
  extra: Record<string, string | number | boolean>;
  exception?: {
    values: { type: string; value: string; stacktrace?: { frames: StackFrame[] } }[];
  };
  message?: { formatted: string };
}

function eventId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

/**
 * The stack BELOW the message. V8's stack text begins with `Name: message`, so
 * for a failed query it repeats every bound value — and a value shaped like
 * `at x (y:1:2)` would otherwise be parsed as a frame. Only what follows the
 * message is read for frames.
 */
function framesOf(error: Error): StackFrame[] {
  const { stack, message } = error;
  if (!stack) return [];
  const at = message ? stack.indexOf(message) : -1;
  return parseStack(at === -1 ? stack : stack.slice(at + message.length));
}

/**
 * The message of one error, as it may leave the box. SQLSTATE class 22 (data
 * exception) is the Postgres family that quotes the offending INPUT in its
 * message — `invalid input syntax for type uuid: "…"`, an unknown enum value —
 * so its quoted strings are blanked. The constraint and not-null classes keep
 * the row in `detail`, which is never read; their messages quote our own
 * identifiers (relation, column, constraint), which the operator needs.
 */
function messageOf(error: Error): string {
  const code = (error as { code?: unknown }).code;
  const dataException = typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code);
  return scrubText(dataException ? error.message.replace(/"[^"]*"/g, '"[value]"') : error.message);
}

/** How many `cause` links are followed: drizzle -> pg is the usual depth of two. */
const MAX_CHAIN = 3;

type ExceptionValue = NonNullable<ErrorEvent['exception']>['values'][number];

function exceptionValue(error: unknown): ExceptionValue {
  if (!(error instanceof Error)) return { type: 'NonError', value: scrubText(String(error)) };
  const frames = framesOf(error);
  return {
    type: error.name || 'Error',
    value: messageOf(error),
    ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
  };
}

/**
 * Pure: the event that would be sent for a thrown value. Exported for tests.
 *
 * The `cause` chain goes out too, because a DrizzleQueryError says only WHICH
 * query failed; WHY (the pg error: a deadlock, a CHECK, a missing relation) is
 * its cause. Each link passes through the same scrubbing, and the protocol wants
 * them innermost first, so the thrown error is the last value.
 */
export function buildExceptionEvent(
  error: unknown,
  options: {
    component: string;
    environment?: string | undefined;
    release?: string | undefined;
    transaction?: string | undefined;
    tags?: ReportContext | undefined;
    extra?: ReportContext | undefined;
    now: number;
  },
): ErrorEvent {
  const chain: unknown[] = [];
  for (
    let link: unknown = error;
    link !== undefined && link !== null && chain.length < MAX_CHAIN && !chain.includes(link);
    link = link instanceof Error ? link.cause : undefined
  ) {
    chain.push(link);
  }
  return {
    event_id: eventId(),
    timestamp: options.now / 1000,
    platform: 'node',
    level: 'error',
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.release ? { release: options.release } : {}),
    ...(options.transaction ? { transaction: scrubText(options.transaction) } : {}),
    tags: { component: options.component, ...cleanContext(options.tags) },
    extra: cleanContext(options.extra),
    exception: { values: chain.reverse().map(exceptionValue) },
  };
}

export function serializeEnvelope(event: ErrorEvent, sentAt: Date): string {
  const header = JSON.stringify({ event_id: event.event_id, sent_at: sentAt.toISOString() });
  const payload = JSON.stringify(event);
  return `${header}\n${JSON.stringify({ type: 'event' })}\n${payload}\n`;
}

export interface ErrorReporter {
  /** False when reporting is off, throttled, or the send failed. Never throws. */
  captureException(
    error: unknown,
    context?: { transaction?: string; tags?: ReportContext; extra?: ReportContext },
  ): Promise<boolean>;
  /** A condition worth an alert that is not an exception (e.g. "3 mails failed"). */
  captureMessage(
    message: string,
    context?: { level?: 'error' | 'warning'; tags?: ReportContext; extra?: ReportContext },
  ): Promise<boolean>;
  readonly enabled: boolean;
}

export function createErrorReporter(options: ReporterOptions): ErrorReporter {
  const dsn = parseDsn(options.dsn);
  const now = options.now ?? Date.now;
  const maxPerMinute = options.maxPerMinute ?? 30;
  const timeoutMs = options.timeoutMs ?? 5000;
  // A crash loop must not become a flood: past the budget the reporter goes
  // quiet until the minute rolls over, and the logs still have everything.
  const sentAt: number[] = [];

  async function send(event: ErrorEvent): Promise<boolean> {
    if (!dsn) return false;
    const t = now();
    while (sentAt.length > 0 && (sentAt[0] ?? 0) <= t - 60_000) sentAt.shift();
    if (sentAt.length >= maxPerMinute) return false;
    sentAt.push(t);
    try {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      const response = await fetchImpl(envelopeUrl(dsn), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=sportkarta-error-report/1, sentry_key=${dsn.publicKey}`,
        },
        body: serializeEnvelope(event, new Date(t)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    enabled: dsn !== null,
    captureException(error, context) {
      if (!dsn) return Promise.resolve(false);
      return send(
        buildExceptionEvent(error, {
          component: options.component,
          environment: options.environment,
          release: options.release,
          transaction: context?.transaction,
          tags: context?.tags,
          extra: context?.extra,
          now: now(),
        }),
      );
    },
    captureMessage(message, context) {
      if (!dsn) return Promise.resolve(false);
      return send({
        event_id: eventId(),
        timestamp: now() / 1000,
        platform: 'node',
        level: context?.level ?? 'warning',
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.release ? { release: options.release } : {}),
        tags: { component: options.component, ...cleanContext(context?.tags) },
        extra: cleanContext(context?.extra),
        message: { formatted: scrubText(message) },
      });
    },
  };
}

/**
 * Wrap an async function so a rejection is REPORTED AND THEN RE-THROWN
 * unchanged. The caller's failure semantics — pg-boss marking the job failed
 * and retrying it, a request rendering its error page — stay exactly what they
 * were; the only difference is that somebody hears about it.
 */
export function reportFailures<A extends unknown[], R>(
  reporter: ErrorReporter,
  context: { tags?: ReportContext; extra?: ReportContext },
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error: unknown) {
      await reporter.captureException(error, context);
      throw error;
    }
  };
}
