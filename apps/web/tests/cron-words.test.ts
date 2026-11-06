import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeCron, weekdayName } from '../lib/cron-words';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * /admin/zdrave prints every schedule in words beside its cron (UX audit
 * 2026-10-31, V-04). The parser knows only the shapes the worker uses, so
 * this holds every `boss.schedule(...)` in apps/worker/src/index.ts — and the
 * heartbeat's own constant — to «describable»: a new shape must teach the
 * parser before it can ship as a bare expression.
 */
const WORKER = readFileSync(join(__dirname, '..', '..', 'worker', 'src', 'index.ts'), 'utf8');

describe('describeCron', () => {
  it('reads the shapes the worker schedules', () => {
    expect(describeCron('* * * * *')).toEqual({ kind: 'everyMinute' });
    expect(describeCron('*/10 * * * *')).toEqual({ kind: 'everyMinutes', n: 10 });
    expect(describeCron('7 * * * *')).toEqual({ kind: 'hourly', minute: '07' });
    expect(describeCron('17 3 * * *')).toEqual({ kind: 'daily', time: '03:17' });
    expect(describeCron('0 8 * * 1')).toEqual({ kind: 'weekly', weekday: 1, time: '08:00' });
    expect(describeCron('15 6 1 * *')).toEqual({ kind: 'monthly', day: 1, time: '06:15' });
  });

  it('treats 7 as Sunday, like cron', () => {
    expect(describeCron('0 8 * * 7')).toEqual({ kind: 'weekly', weekday: 0, time: '08:00' });
  });

  it('answers null rather than guess at a shape it does not know', () => {
    for (const cron of [
      '0 8 * * 1-5',
      '0 8 1 6 *',
      '*/90 * * * *',
      '61 * * * *',
      '0 25 * * *',
      'nonsense',
      '',
    ]) {
      expect(describeCron(cron), cron).toBeNull();
    }
  });

  it('describes every schedule the worker registers', () => {
    const crons = [...WORKER.matchAll(/boss\.schedule\(\s*[A-Z_]+\s*,\s*'([^']+)'/g)].map(
      (m) => m[1] as string,
    );
    const heartbeat = /HEALTH_SCHEDULE = '([^']+)'/.exec(WORKER)?.[1];
    expect(crons.length).toBeGreaterThan(20);
    expect(heartbeat).toBeTruthy();
    for (const cron of [...crons, heartbeat as string]) {
      expect(describeCron(cron), cron).not.toBeNull();
    }
  });

  it('has words for every shape, in both languages', () => {
    const kinds = ['everyMinute', 'everyMinutes', 'hourly', 'daily', 'weekly', 'monthly', 'inUtc'];
    for (const messages of [bg, en]) {
      const words = (messages.AdminHealth as { cron: Record<string, string> }).cron;
      for (const kind of kinds) expect(typeof words[kind], kind).toBe('string');
    }
  });

  it('names the weekday in the page language', () => {
    expect(weekdayName(1, 'bg')).toBe('понеделник');
    expect(weekdayName(0, 'en-GB')).toBe('Sunday');
  });
});
