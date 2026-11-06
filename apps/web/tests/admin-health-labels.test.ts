import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { queueKey } from '../lib/ops-health';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * Every queue the worker registers has its Bulgarian name on /admin/zdrave
 * (UX audit 2026-10-31, V-04 and Q-02: the fifteen `club.*` queues were
 * printed as their keys). The queue names are read from the source that
 * declares them — the worker's own, and lib/src/clubs/jobs.ts for the club
 * queues the web app enqueues too — as worker-schedules.test.ts does, so a
 * new queue cannot ship without a label.
 */
const REPO = join(__dirname, '..', '..', '..');
const WORKER =
  readFileSync(join(REPO, 'apps', 'worker', 'src', 'index.ts'), 'utf8') +
  readFileSync(join(REPO, 'lib', 'src', 'clubs', 'jobs.ts'), 'utf8');

describe('queue labels on /admin/zdrave', () => {
  const queues = [...WORKER.matchAll(/const [A-Z_]+_QUEUE = '([a-z._-]+)'/g)].map(
    (m) => m[1] as string,
  );

  it('finds the worker queues', () => {
    expect(queues.length).toBeGreaterThan(25);
    expect(queues).toContain('club.payment_event');
  });

  it('turns a queue name into its message key', () => {
    expect(queueKey('session.notify')).toBe('sessionNotify');
    expect(queueKey('club.payment_event')).toBe('clubPaymentEvent');
    expect(queueKey('club.integrations_prune')).toBe('clubIntegrationsPrune');
  });

  it.each([
    ['bg', bg],
    ['en', en],
  ])('names every queue in %s', (_locale, messages) => {
    const labels = (messages.AdminHealth as { queue: Record<string, string> }).queue;
    const missing = queues.filter((queue) => typeof labels[queueKey(queue)] !== 'string');
    expect(missing).toEqual([]);
  });

  it('keeps no label for a queue that does not exist', () => {
    const labels = (bg.AdminHealth as { queue: Record<string, string> }).queue;
    const keys = new Set(queues.map(queueKey));
    expect(Object.keys(labels).filter((key) => !keys.has(key))).toEqual([]);
  });
});
