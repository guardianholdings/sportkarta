import { getDb, releaseMailBudget, takeMailBudget, type MailBudgetSlot } from '@sportkarta/db';
import { resolveMailBudget, type MailBudgetLimits } from '@sportkarta/lib/email';

/**
 * The web process's side of the daily mail budget (lib/src/email/budget.ts
 * has the shares, db/src/mail-budget.ts the counter). The web sends exactly
 * ONE kind of mail itself — the sign-in code; every other mail is the
 * worker's — so this is where the code share is spent: after the in-memory
 * limiters (lib/auth-rate-limit.ts) and BEFORE a code is minted, so a refused
 * request neither mails nor leaves a verification row behind.
 *
 * Fails CLOSED, like a missing relay: when the budget cannot be read, no code
 * goes out. The realistic causes are a database that is down — better-auth
 * could not mint a code then either — or a migration that has not run, which
 * the log line names. Never an address in a log line.
 */

const globalForBudget = globalThis as unknown as { __mailBudgetLimits?: MailBudgetLimits };

/** The limits from the environment, read once per process. */
export function mailBudgetLimits(): MailBudgetLimits {
  return (globalForBudget.__mailBudgetLimits ??= resolveMailBudget(process.env));
}

export interface ReservedMailSlot {
  /** The code did not go out after all: give the slot back. Never throws. */
  release(): Promise<void>;
}

/** An error reduced to its class and code — a pg error's message can quote a statement. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? `${error.name} ${code}`
    : error.name;
}

/**
 * One slot of today's sign-in-code share, or null when it is spent (or
 * unreadable). The caller releases it if the send then fails, so a relay
 * outage cannot burn the share on codes that never left.
 */
export async function reserveSignInCodeMail(): Promise<ReservedMailSlot | null> {
  let slot: MailBudgetSlot;
  try {
    const outcome = await takeMailBudget(getDb(), 'otp', mailBudgetLimits());
    if (!outcome.granted) return null;
    slot = outcome.slot;
  } catch (error: unknown) {
    console.error(
      `[auth] sign-in code held: the mail budget could not be read (${describe(error)})`,
    );
    return null;
  }
  return {
    async release() {
      try {
        await releaseMailBudget(getDb(), slot);
      } catch (error: unknown) {
        // The slot stays spent — conservative — and the member has their answer.
        console.error(`[auth] a sign-in code slot could not be released (${describe(error)})`);
      }
    },
  };
}
