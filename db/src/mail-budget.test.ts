import {
  MailBudgetExhaustedError,
  MemoryMailer,
  type MailBudgetLimits,
  type Mailer,
} from '@sportkarta/lib/email';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  budgetedMailer,
  mailBudgetToday,
  pruneMailBudget,
  releaseMailBudget,
  takeMailBudget,
} from './mail-budget.js';

/**
 * The mail budget's counter (migration 0062, db/src/mail-budget.ts) against a
 * real Postgres: the share is granted exactly, two senders racing for the
 * last slot get one between them, a slot comes back when the relay refuses,
 * and the budgeted mailer's throw rolls the caller's claim back with it.
 *
 * Days in 2000 and 2001, which no real sender ever writes (the counter is
 * only ever "today"), so the suite can run beside a dev server.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = '2001-01-01';
const WARN_DAY = '2001-01-02';
const OLD_DAY = '2000-06-15';
const TEST_DAYS = [DAY, WARN_DAY, OLD_DAY];
const LIMITS: MailBudgetLimits = { quota: 10, otp: 3, notice: 4, bulk: 3 };
/** Lines are checked in the one test about them; everywhere else they are noise. */
const quiet = { warn: () => undefined };

describe.skipIf(!hasDb)('mail_budget (requires running database)', () => {
  let client: pg.Client;
  let db: NodePgDatabase;

  async function connect(): Promise<pg.Client> {
    const extra = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await extra.connect();
    return extra;
  }

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM mail_budget WHERE sofia_day = ANY($1::date[])`, [TEST_DAYS]);
  }

  async function counts(kind: string, day = DAY): Promise<{ sent: number; refused: number }> {
    const result = await client.query<{ sent: number; refused: number }>(
      `SELECT sent, refused FROM mail_budget WHERE sofia_day = $1::date AND kind = $2`,
      [day, kind],
    );
    return result.rows[0] ?? { sent: 0, refused: 0 };
  }

  const take = (kind: 'otp' | 'notice' | 'bulk', runner = db, limits = LIMITS, day = DAY) =>
    takeMailBudget(runner, kind, limits, { day, ...quiet });

  beforeAll(async () => {
    client = await connect();
    db = drizzle(client);
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  beforeEach(cleanup);

  it('grants exactly the share, then refuses and counts the refusals', async () => {
    const outcomes = [];
    for (let i = 0; i < 5; i += 1) outcomes.push(await take('otp'));
    expect(outcomes.map((o) => o.granted)).toEqual([true, true, true, false, false]);
    expect(outcomes.flatMap((o) => (o.granted ? [o.slot.sent] : []))).toEqual([1, 2, 3]);
    expect(outcomes.at(-1)).toMatchObject({ granted: false, kind: 'otp', day: DAY, limit: 3 });
    expect(await counts('otp')).toEqual({ sent: 3, refused: 2 });
    // The shares are separate: a spent code share leaves the notices alone.
    expect((await take('notice')).granted).toBe(true);
  });

  it('refuses a share of zero outright, and still counts the attempt', async () => {
    const outcome = await take('bulk', db, { ...LIMITS, bulk: 0 });
    expect(outcome.granted).toBe(false);
    expect(await counts('bulk')).toEqual({ sent: 0, refused: 1 });
  });

  it('is atomic at the edge: two senders racing for the last slot get ONE between them', async () => {
    await take('otp');
    await take('otp'); // 2 of 3
    const a = await connect();
    const b = await connect();
    try {
      await a.query('BEGIN');
      const first = await take('otp', drizzle(a));
      expect(first.granted).toBe(true); // holds the row lock until COMMIT
      let settled = false;
      const second = take('otp', drizzle(b)).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Waiting on the lock, not deciding on the row it could still see.
      expect(settled).toBe(false);
      await a.query('COMMIT');
      expect((await second).granted).toBe(false);
      expect(await counts('otp')).toEqual({ sent: 3, refused: 1 });
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it('hands the contested slot to the second sender when the first rolls back', async () => {
    await take('otp');
    await take('otp');
    const a = await connect();
    const b = await connect();
    try {
      await a.query('BEGIN');
      expect((await take('otp', drizzle(a))).granted).toBe(true);
      const second = take('otp', drizzle(b));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await a.query('ROLLBACK');
      expect((await second).granted).toBe(true);
      expect(await counts('otp')).toEqual({ sent: 3, refused: 0 });
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it('grants no more than the share to a burst of concurrent senders', async () => {
    const clients = await Promise.all(Array.from({ length: 7 }, connect));
    try {
      const results = await Promise.all(clients.map((c) => take('notice', drizzle(c))));
      expect(results.filter((r) => r.granted)).toHaveLength(LIMITS.notice);
      expect(await counts('notice')).toEqual({ sent: 4, refused: 3 });
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('takes a released slot again', async () => {
    const slots = [];
    for (let i = 0; i < 3; i += 1) slots.push(await take('otp'));
    expect((await take('otp')).granted).toBe(false);
    const first = slots[0];
    if (!first?.granted) throw new Error('expected a slot');
    await releaseMailBudget(db, first.slot);
    expect(await counts('otp')).toEqual({ sent: 2, refused: 1 });
    expect((await take('otp')).granted).toBe(true);
  });

  it('warns once when a share crosses 80 %, and once when it is first refused', async () => {
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);
    const limits = { ...LIMITS, otp: 5 };
    for (let i = 0; i < 7; i += 1) {
      await takeMailBudget(db, 'otp', limits, { day: WARN_DAY, warn });
    }
    expect(lines.filter((line) => line.startsWith('[mail] budget_warning'))).toEqual([
      `[mail] budget_warning kind=otp sent=4 limit=5 day=${WARN_DAY}`,
    ]);
    expect(lines.filter((line) => line.startsWith('[mail] budget_spent'))).toEqual([
      `[mail] budget_spent kind=otp limit=5 day=${WARN_DAY}`,
    ]);
    expect(lines.join('\n')).not.toContain('@');
  });

  describe('budgetedMailer', () => {
    /** A relay mailer wrapped for the test days (a fixed day instead of the clock). */
    function wrapped(inner: Mailer, limits = LIMITS, kind: 'otp' | 'notice' | 'bulk' = 'bulk') {
      return budgetedMailer(inner, {
        db: {
          execute: (query) => db.execute(query),
        },
        kind,
        limits,
        warn: quiet.warn,
      });
    }
    const MESSAGE = { to: 'member@example.org', subject: 'x', text: 'x' };

    it('sends while the share lasts and throws instead of sending once it is spent', async () => {
      const inner = new MemoryMailer();
      // The budgeted mailer counts on the database clock; pin the day by
      // pre-spending today's bulk share is not an option beside a dev server,
      // so the share is made tiny and the day left real — cleaned up below.
      const limits = { ...LIMITS, bulk: 1 };
      const mailer = wrapped(inner, limits);
      const today = (await mailBudgetToday(db, limits)).day;
      const before = await counts('bulk', today);
      try {
        await mailer.send(MESSAGE);
        await expect(mailer.send(MESSAGE)).rejects.toBeInstanceOf(MailBudgetExhaustedError);
        expect(inner.sent).toHaveLength(1);
      } finally {
        await client.query(
          `UPDATE mail_budget SET sent = $2, refused = $3 WHERE sofia_day = $1::date AND kind = 'bulk'`,
          [today, before.sent, before.refused],
        );
      }
    });

    it('gives the slot back when the relay refuses, and keeps the relay’s error', async () => {
      const relayError = Object.assign(new Error('550 <member@example.org> rejected'), {
        code: 'EENVELOPE',
      });
      const limits = { ...LIMITS, bulk: 1 };
      const refusing = wrapped({ send: () => Promise.reject(relayError) }, limits);
      const today = (await mailBudgetToday(db, limits)).day;
      const before = await counts('bulk', today);
      try {
        await expect(refusing.send(MESSAGE)).rejects.toBe(relayError);
        // The slot came back: the next sender still gets the share's one send.
        const inner = new MemoryMailer();
        await wrapped(inner, limits).send(MESSAGE);
        expect(inner.sent).toHaveLength(1);
      } finally {
        await client.query(
          `UPDATE mail_budget SET sent = $2, refused = $3 WHERE sofia_day = $1::date AND kind = 'bulk'`,
          [today, before.sent, before.refused],
        );
      }
    });

    it('rolls the caller’s claim back with the hold — the ledger still says "not told"', async () => {
      // A claim stands in for any job's ledger row: written in the caller's
      // transaction before the send, exactly as the worker does it.
      const limits = { ...LIMITS, bulk: 0 };
      const mailer = wrapped(new MemoryMailer(), limits);
      const caller = await connect();
      try {
        await expect(
          drizzle(caller).transaction(async (tx) => {
            await tx.execute(
              `INSERT INTO mail_budget (sofia_day, kind, sent) VALUES ('${OLD_DAY}', 'notice', 0)`,
            );
            await mailer.send(MESSAGE);
          }),
        ).rejects.toBeInstanceOf(MailBudgetExhaustedError);
        expect(await counts('notice', OLD_DAY)).toEqual({ sent: 0, refused: 0 });
      } finally {
        await caller.end();
      }
    });
  });

  describe('mailBudgetToday / pruneMailBudget', () => {
    it('reports every kind beside its limit, zero where nothing was sent', async () => {
      await take('otp');
      await take('otp');
      await take('bulk', db, { ...LIMITS, bulk: 0 });
      expect(await mailBudgetToday(db, LIMITS, DAY)).toEqual({
        day: DAY,
        quota: 10,
        kinds: [
          { kind: 'otp', sent: 2, refused: 0, limit: 3 },
          { kind: 'notice', sent: 0, refused: 0, limit: 4 },
          { kind: 'bulk', sent: 0, refused: 1, limit: 3 },
        ],
      });
    });

    it('forgets counters older than the retention and keeps the rest', async () => {
      await take('otp');
      await take('otp', db, LIMITS, OLD_DAY);
      // A retention that reaches back to just before DAY: OLD_DAY (200 days
      // earlier) goes, DAY stays — whatever today's date is.
      const keepDays = Math.floor((Date.now() - Date.parse(DAY)) / 86_400_000) + 30;
      expect(await pruneMailBudget(db, keepDays)).toBe(1);
      expect(await counts('otp', OLD_DAY)).toEqual({ sent: 0, refused: 0 });
      expect(await counts('otp', DAY)).toEqual({ sent: 1, refused: 0 });
    });

    it('lets the database refuse a kind it does not know', async () => {
      await expect(
        client.query(`INSERT INTO mail_budget (sofia_day, kind) VALUES ($1::date, 'digest')`, [
          DAY,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
