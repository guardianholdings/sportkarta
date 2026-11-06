import { randomInt } from 'node:crypto';

import { unstable_rethrow } from 'next/navigation';

/**
 * B5: the add action's safety net. A failure that is neither a refusal the form
 * can explain (ContributionError, handled before this) nor Next's own control
 * flow (redirect, notFound: rethrown first) is OUR failure. The member gets
 * line 11 with a reference code instead of the error page, and the server log
 * gets one line with the same code, so a member's message can be matched to
 * exactly one log line.
 *
 * That line never carries the error's message: a database error can quote the
 * values it was given, i.e. what the member typed. It carries the code, the
 * error's name, a constant error code (SQLSTATE, ECONNRESET…) and the stack
 * FRAMES, which are code locations; never the member, never a coordinate.
 */
export function unexpectedFailure(
  scope: string,
  error: unknown,
  log: (line: string) => void = console.error,
): { reference: string } {
  unstable_rethrow(error);
  const reference = newReference();
  const name = error instanceof Error ? error.name : typeof error;
  const code = constantCode(error);
  const frames =
    error instanceof Error && typeof error.stack === 'string'
      ? stackFrames(error.stack, error.message)
      : [];
  log(
    [
      `[${scope}] unexpected failure ref=${reference} ${name}${code ? ` code=${code}` : ''}`,
      ...frames,
    ].join('\n'),
  );
  return { reference };
}

/** Crockford base32: no I, L, O or U, so a code read out over the phone survives. */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 8 characters, 40 random bits: unique enough to find one log line. */
export function newReference(): string {
  let reference = '';
  for (let i = 0; i < 8; i += 1) {
    reference += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return reference;
}

/**
 * The stack's frames, which are code locations. V8 writes the message first
 * and the frames after it, so the message is skipped by its own line count:
 * a message line that happens to start with "at " can never pass as a frame
 * (drizzle's message is the query and its parameters).
 */
function stackFrames(stack: string, message: string): string[] {
  const header = message === '' ? 1 : message.split('\n').length;
  return stack
    .split('\n')
    .slice(header)
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 8);
}

/**
 * An error code that is a constant (SQLSTATE 23505, ECONNRESET), never free
 * text. drizzle wraps a database failure (DrizzleQueryError) and keeps pg's own
 * error, with the SQLSTATE, on `cause`; the wrapper's message is the query and
 * its parameters, one more reason the message is never logged.
 */
function constantCode(error: unknown): string | null {
  return codeOf(error) ?? codeOf(causeOf(error));
}

function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const { code } = error;
  return typeof code === 'string' && /^[0-9A-Z_]{2,32}$/.test(code) ? code : null;
}

function causeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined;
}
