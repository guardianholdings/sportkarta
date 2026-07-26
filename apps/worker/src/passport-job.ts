import {
  appliedStreakFreezes,
  applyStreakFreeze,
  badgeEvaluationCandidates,
  evaluateAndRecordBadges,
  getDb,
  passportEvents,
  streakFreezeCandidates,
} from '@sportkarta/db';
import { freezeCandidate } from '@sportkarta/lib/badges';

/**
 * Badge evaluation, off the passport render path (docs/ENGAGEMENT-IMPLEMENTATION.md,
 * phase 3 / item A1).
 *
 * THE PROBLEM. `recordEarnedBadges` had exactly one caller — `ownPassport()` —
 * so a badge did not EXIST until the member personally opened /pasport. Nothing
 * could notify them, nothing could count what was unseen, and the weekly digest
 * had no badge to mention, because for most members the row had never been
 * written. The engine was correct and unreachable.
 *
 * WHY A JOB AND NOT THE WRITE PATH. `passportEvents` is unbounded by design (a
 * badge is a claim about someone's whole history), so evaluating inline would
 * put an O(history) scan plus an in-memory fold inside the transaction that adds
 * a facility — and inside `checkIn`, where it could roll back an attendance.
 * That would break the invariant the anti-abuse layer is built on: attendance is
 * a fact and is ALWAYS recorded; only the payment stops. So the web app enqueues
 * after the write has committed, and a lost job costs nothing that is not
 * already the status quo — `ownPassport()` still records on the next visit, and
 * the insert is ON CONFLICT DO NOTHING.
 *
 * NO MAIL HERE, YET. This job records and marks; it sends nothing. The mail
 * layer needs a frequency cap and an unsubscribe route that are still operator
 * decisions, and shipping a notifier before those exist is how a member ends up
 * with four engagement emails in one weekend.
 */

/**
 * How recently a badge must have been earned to count as NEW.
 *
 * A badge earned inside this window lights up (the "ново" pill, and the nav
 * dot); anything older is recorded already-seen. This is what makes the
 * retroactive back catalogue silent — see `RecordBadgesOptions.unseenSince` in
 * db/src/passport.ts for why it is a cutoff rather than a flag.
 *
 * An hour is generous on purpose: it has to cover queue lag, a worker restart
 * and a retry, and the cost of being generous is only that a badge earned an
 * hour ago still reads as new — which it is.
 */
const NEW_BADGE_WINDOW_MS = 60 * 60 * 1000;

export interface PassportEvaluateJobData {
  /** ACCOUNT id. Never an address — a job row outlives the account it names. */
  userId?: string;
}

export interface EvaluateReport {
  evaluated: number;
  recorded: number;
  failed: number;
}

function unseenSince(now: Date): Date {
  return new Date(now.getTime() - NEW_BADGE_WINDOW_MS);
}

/**
 * Evaluate one member, after one of their contributions or check-ins committed.
 */
export async function runPassportEvaluate(
  data: PassportEvaluateJobData,
  now: Date = new Date(),
): Promise<EvaluateReport> {
  const userId = data.userId;
  if (!userId) return { evaluated: 0, recorded: 0, failed: 0 };

  const recorded = await evaluateAndRecordBadges(getDb(), userId, {
    now,
    unseenSince: unseenSince(now),
  });
  // Counts only, never the account id: no PII in logs, and an account id is a
  // stable identifier for a person even without their name attached.
  return { evaluated: 1, recorded: recorded.length, failed: 0 };
}

/**
 * Evaluate EVERY member who has ever earned a point.
 *
 * This is the one-shot that makes the feature safe to turn on: without it, the
 * first contribution a long-standing member makes would record their entire back
 * catalogue at once. With the `unseenSince` cutoff, though, there is nothing
 * special about this job at all — it is the same call as the per-member one, and
 * every badge it writes is historical and therefore silent. That symmetry is
 * deliberate: it means the backfill and the live path cannot disagree, and a
 * contribution arriving mid-backfill is not a race.
 *
 * Sequential rather than parallel: it runs once, it is not latency-sensitive,
 * and one unbounded history scan at a time is kinder to a single-VPS Postgres
 * than N of them. One member's failure must not abandon the rest, so each is
 * caught and counted.
 */
export async function runBadgeBackfill(now: Date = new Date()): Promise<EvaluateReport> {
  const db = getDb();
  const userIds = await badgeEvaluationCandidates(db);
  const cutoff = unseenSince(now);

  const report: EvaluateReport = { evaluated: 0, recorded: 0, failed: 0 };
  for (const userId of userIds) {
    try {
      const recorded = await evaluateAndRecordBadges(db, userId, { now, unseenSince: cutoff });
      report.evaluated += 1;
      report.recorded += recorded.length;
    } catch (error) {
      report.failed += 1;
      // A CATEGORY, never the member: the message can embed a query, and the
      // account id identifies a person.
      console.error(
        '[worker] badges.backfill member failed:',
        error instanceof Error ? error.name : 'unknown',
      );
    }
  }
  return report;
}

/**
 * Apply streak freezes for the week that just closed («замразяване», A4).
 *
 * Runs after the week boundary. For each member with recent attendance it asks
 * the pure `freezeCandidate` whether the closed week is one worth forgiving,
 * and records it if so. Almost every answer is null — a freeze is only ever
 * applied to a week that would otherwise END a live run.
 *
 * SILENTLY, by design. ENGAGEMENT.md A4's finding is that freezes work because
 * they apply without ceremony; the member simply finds their streak intact.
 * Nothing here mails, and the table's COMMENT pins the language: a freeze is
 * APPLIED, never spent or used up.
 *
 * Sequential and per-member try/catch, matching the backfill: one member's bad
 * history must not abandon everyone else's.
 */
export async function runStreakFreezes(now: Date = new Date()): Promise<EvaluateReport> {
  const db = getDb();
  const userIds = await streakFreezeCandidates(db);

  const report: EvaluateReport = { evaluated: 0, recorded: 0, failed: 0 };
  for (const userId of userIds) {
    try {
      const [events, applied] = await Promise.all([
        passportEvents(db, userId),
        appliedStreakFreezes(db, userId),
      ]);
      report.evaluated += 1;
      // The week streak is PARTICIPATION, so the candidate is decided on the
      // same event subset passportStreaks folds — otherwise a contribution
      // could quietly hold a participation streak together.
      const checkins = events.filter((event) => event.kind === 'session_checkin');
      const key = freezeCandidate(checkins, applied, { now });
      if (key && (await applyStreakFreeze(db, userId, key))) report.recorded += 1;
    } catch (error) {
      report.failed += 1;
      console.error(
        '[worker] streaks.freeze member failed:',
        error instanceof Error ? error.name : 'unknown',
      );
    }
  }
  return report;
}
