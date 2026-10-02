import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Worker job configuration, read from the worker's own source.
 *
 * The worker package has no test runner, so — like digest.test.ts and
 * deploy-worker-env.test.ts — this reads apps/worker/src/index.ts as text. What
 * it pins are three pre-launch audit findings that no unit test could see,
 * because each lived in a line of configuration rather than in a function:
 *
 *  1. A Sofia-time schedule inside the DST hour. The EU clock change happens at
 *     01:00 UTC, which in Sofia is the 03:00 hour: skipped on the last Sunday of
 *     March, repeated on the last Sunday of October. The open-data dump sat at
 *     03:40 and so ran twice every October — rewriting a version already served
 *     `immutable` — and not at all every March. The hour is DERIVED from the tz
 *     database here, not hardcoded, like the streak and campaign-window suites.
 *  2. A "one import at a time" guard that was a no-op: pg-boss 10 enforces a
 *     singletonKey only on 'short', 'singleton' or 'stately' queues, and
 *     createQueue never changes a queue that already exists.
 *  3. Throughput. Default fetching is one job per 2 s poll, ~1,800 an hour, for
 *     the two queues the web app feeds one job per member action. Fetching in
 *     batches fixes that, and per-job failure keeps a batch from failing as one.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const WORKER = readFileSync(join(REPO_ROOT, 'apps', 'worker', 'src', 'index.ts'), 'utf8');
const IMPORT_ACTION = readFileSync(
  join(REPO_ROOT, 'apps', 'web', 'app', '[locale]', 'admin', '(protected)', 'import', 'actions.ts'),
  'utf8',
);

const SOFIA = 'Europe/Sofia';

interface Schedule {
  queue: string;
  cron: string;
  tz: string | null;
}

function schedules(): Schedule[] {
  const pattern =
    /boss\.schedule\(\s*([A-Z_]+)\s*,\s*'([^']+)'(?:\s*,\s*\{\s*\}\s*,\s*\{\s*tz:\s*'([^']+)'\s*\})?\s*\)/g;
  return [...WORKER.matchAll(pattern)].map((match) => ({
    queue: match[1] as string,
    cron: match[2] as string,
    tz: match[3] ?? null,
  }));
}

function sofiaHour(ms: number): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: SOFIA, hour: '2-digit', hourCycle: 'h23' }).format(
      ms,
    ),
  );
}

/**
 * Local hours that are skipped or repeated on some day, found by walking UTC in
 * whole hours and noticing where Sofia's wall clock does not advance by exactly
 * one: +2 means an hour was skipped, +0 means one was repeated.
 */
function unsafeSofiaHours(fromYear: number, toYear: number): Set<number> {
  const hours = new Set<number>();
  const HOUR = 60 * 60 * 1000;
  for (let t = Date.UTC(fromYear, 0, 1); t < Date.UTC(toYear, 0, 1); t += HOUR) {
    const before = sofiaHour(t);
    const after = sofiaHour(t + HOUR);
    const step = (after - before + 24) % 24;
    if (step === 2) hours.add((before + 1) % 24);
    if (step === 0) hours.add(after);
  }
  return hours;
}

describe('worker schedules avoid the DST hour', () => {
  const unsafe = unsafeSofiaHours(2026, 2032);

  it('finds the transition hour from the tz database (the suite is not vacuous)', () => {
    expect([...unsafe]).toEqual([3]);
  });

  it('parses every Sofia-time schedule the worker declares', () => {
    const sofia = schedules().filter((schedule) => schedule.tz === SOFIA);
    expect(sofia.map((schedule) => schedule.queue).sort()).toEqual(
      [
        'DIGEST_WEEKLY_QUEUE',
        'DIVISIONS_ROLLOVER_QUEUE',
        'OPENDATA_DUMP_QUEUE',
        'STREAK_FREEZE_QUEUE',
      ].sort(),
    );
  });

  it('never runs a Sofia-time job in an hour that is skipped or repeated', () => {
    for (const schedule of schedules().filter((entry) => entry.tz === SOFIA)) {
      const hourField = schedule.cron.split(/\s+/)[1] ?? '';
      // Only fixed hours can be checked; a stepped or ranged field would need
      // its own reasoning about which runs the transition eats.
      expect(hourField, `${schedule.queue} should run at a fixed hour`).toMatch(/^\d+(,\d+)*$/);
      for (const hour of hourField.split(',').map(Number)) {
        expect(
          unsafe.has(hour),
          `${schedule.queue} (${schedule.cron}) runs in Sofia hour ${String(hour)}, which the ` +
            'clock change skips in March and repeats in October',
        ).toBe(false);
      }
    }
  });
});

describe('queue policies make the singleton guards real', () => {
  it('declares import.osm STATELY and converges an existing queue onto it', () => {
    expect(WORKER).toMatch(/ensureQueuePolicy\(boss,\s*IMPORT_OSM_QUEUE,\s*'stately'\)/);
    // createQueue alone is ON CONFLICT DO NOTHING — the update is what reaches a
    // queue production created as 'standard'.
    expect(WORKER).toMatch(/async function ensureQueuePolicy[\s\S]*?boss\.updateQueue\(/);
  });

  it('has the admin action declare the same policy it relies on', () => {
    expect(IMPORT_ACTION).toMatch(/createQueue\(IMPORT_QUEUE,\s*\{[^}]*policy:\s*'stately'/);
    expect(IMPORT_ACTION).toMatch(/singletonKey:\s*IMPORT_QUEUE/);
  });

  it('declares passport.evaluate SHORT, so one member’s burst queues one fold', () => {
    expect(WORKER).toMatch(/ensureQueuePolicy\(boss,\s*PASSPORT_EVALUATE_QUEUE,\s*'short'\)/);
  });
});

describe('the member-fed queues fetch in batches', () => {
  it('uses a batch size above one', () => {
    const size = Number(/const FEED_BATCH_SIZE = (\d+);/.exec(WORKER)?.[1]);
    expect(size).toBeGreaterThan(1);
  });

  it.each(['PASSPORT_EVALUATE_QUEUE', 'SESSION_NOTIFY_QUEUE'])('applies it to %s', (queue) => {
    expect(WORKER).toMatch(
      new RegExp(`boss\\.work\\(\\s*${queue},\\s*\\{\\s*batchSize:\\s*FEED_BATCH_SIZE\\s*\\}`),
    );
  });

  /**
   * pg-boss fails a whole batch when its handler throws, so a batch without
   * per-job isolation lets one poisoned job fail the jobs queued behind it —
   * unattempted, retry after retry. One-job fetches never had that failure mode,
   * and batching must not introduce it.
   */
  it.each(['PASSPORT_EVALUATE_QUEUE', 'SESSION_NOTIFY_QUEUE'])(
    'fails a throwing %s job alone, not the batch it was fetched in',
    (queue) => {
      expect(WORKER).toMatch(new RegExp(`eachJobIsolated\\(boss,\\s*${queue},\\s*jobs,`));
    },
  );

  it('isolates by catching per job and failing exactly that job', () => {
    const helper = /async function eachJobIsolated[\s\S]*?\n\}/.exec(WORKER)?.[0] ?? '';
    expect(helper).toMatch(/for \(const job of jobs\)\s*\{\s*try\s*\{/);
    expect(helper).toMatch(/boss\.fail\(queue,\s*job\.id,/);
    // A category, never the message, reaches the log (no PII in logs).
    expect(helper).not.toMatch(/error\.message/);
  });
});
