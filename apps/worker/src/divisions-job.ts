import { getDb, runDivisionRollover, type RolloverReport } from '@sportkarta/db';
import { divisionWeekStart } from '@sportkarta/lib/divisions';

/**
 * The weekly division rollover («дивизии», docs/ENGAGEMENT.md B2, phase 9).
 *
 * Runs once a week, after the Sofia week has turned. It scores the week that
 * just closed through the same ranking the ladder showed all week, moves the top
 * of each group up a tier and the bottom down, and writes the groups for the
 * week now beginning.
 *
 * THERE IS NO SEPARATE BOOTSTRAP, and that is the point. The implementation plan
 * flagged that "the rollover closes last week and assigns next — nothing creates
 * week one, so it is a no-op forever without it". The fix was not a second job
 * but a shape: `runDivisionRollover` derives each member's tier from whatever
 * history exists, and when there is none, everyone starts at the entry tier.
 * Week one is the general case with an empty left-hand side. A dedicated seeding
 * job would have been a code path that runs exactly once, in production,
 * unrehearsed — the same trap the badge backfill avoided in phase 3 by being a
 * cutoff rather than a flag.
 *
 * A MISSED WEEK DEGRADES CORRECTLY. If the worker is down on a Monday, the week
 * gets no groups. The following week then finds no closed ladder, so nobody
 * promotes or relegates — and nobody is reset either, because a member's tier
 * comes from the last week they were ASSIGNED rather than from last week
 * specifically. The ladder resumes where it stopped, which is the only outcome
 * that does not punish members for an outage they had no part in.
 *
 * NOTHING IS MAILED. Like the freeze job beside it, this records and moves; the
 * mail layer still needs a frequency cap and an unsubscribe route, both open
 * operator decisions. A member finds their new division when they next open
 * /klasirane.
 */
export async function runDivisions(now: Date = new Date()): Promise<RolloverReport> {
  // The week now BEGINNING — the one being assigned. `divisionWeekStart`
  // delegates to `bucketKeyFor`, the one place an instant becomes a calendar
  // position, so this cannot disagree with the streaks or the digest about when
  // Monday started.
  const week = divisionWeekStart(now);
  const report = await runDivisionRollover(getDb(), week, { now });

  // Counts and a week key only. No account ids: an id is a stable identifier for
  // a person even with no name attached, and this job touches every member.
  if (report.belowFloor) {
    console.log(`[worker] divisions.rollover ${report.week}: below floor, nothing written`);
  } else {
    console.log(
      `[worker] divisions.rollover ${report.week}: ${report.groups} groups, ${report.members} members`,
    );
  }
  return report;
}
