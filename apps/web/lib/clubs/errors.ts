/**
 * The Postgres error inside whatever the driver threw.
 *
 * drizzle 0.44+ wraps a failed statement in a DrizzleQueryError whose own
 * message is the SQL text; the server's SQLSTATE, constraint name and message
 * live on `.cause`. Club code maps CONSTRAINT NAMES onto form errors (a
 * payment over the amount owed, a booking before the window opens), so it
 * reads them from here and never from a message string.
 */
export interface PgErrorFields {
  code?: string;
  constraint?: string;
  message: string;
}

export function pgError(error: unknown): PgErrorFields | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
        message: typeof candidate.message === 'string' ? candidate.message : '',
      };
    }
    current = candidate.cause;
  }
  return null;
}

/** The violated constraint's name, or '' — for `switch`-style mapping. */
export function violatedConstraint(error: unknown): string {
  return pgError(error)?.constraint ?? '';
}
