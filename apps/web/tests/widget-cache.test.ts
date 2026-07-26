import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearWidgetCache,
  WIDGET_FRESH_MS,
  WIDGET_STALE_MS,
  widgetCached,
} from '@/lib/widget-cache';

/**
 * The widget micro-cache (Stage 6 hardening): fresh hits skip the load,
 * stale-while-error keeps an embed alive through an outage, and a cold miss
 * during an outage returns null so the route can 503 politely.
 */

const T0 = 1_000_000;
const boom = () => Promise.reject(new Error('db away'));

describe('widgetCached', () => {
  beforeEach(() => {
    clearWidgetCache();
  });

  it('loads once and serves fresh hits without calling the loader again', async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve({ total: 42 });
    };
    const first = await widgetCached('acc:sofia', load, T0);
    const second = await widgetCached('acc:sofia', load, T0 + WIDGET_FRESH_MS - 1);
    expect(first).toEqual({ value: { total: 42 }, degraded: false });
    expect(second).toEqual({ value: { total: 42 }, degraded: false });
    expect(calls).toBe(1);
  });

  it('reloads after the fresh window and replaces the value', async () => {
    let n = 0;
    const load = () => Promise.resolve({ n: (n += 1) });
    await widgetCached('acc:sofia', load, T0);
    const later = await widgetCached('acc:sofia', load, T0 + WIDGET_FRESH_MS + 1);
    expect(later?.value).toEqual({ n: 2 });
    expect(later?.degraded).toBe(false);
  });

  it('serves the stale copy, flagged degraded, when the reload fails', async () => {
    await widgetCached('acc:sofia', () => Promise.resolve({ total: 42 }), T0);
    const outage = await widgetCached('acc:sofia', boom, T0 + WIDGET_FRESH_MS + 1);
    expect(outage).toEqual({ value: { total: 42 }, degraded: true });
  });

  it('gives up once the stale window is over', async () => {
    await widgetCached('acc:sofia', () => Promise.resolve({ total: 42 }), T0);
    const ancient = await widgetCached('acc:sofia', boom, T0 + WIDGET_STALE_MS + 1);
    expect(ancient).toBeNull();
  });

  it('returns null on a cold miss during an outage — the route 503s', async () => {
    const cold = await widgetCached('acc:nowhere', boom, T0);
    expect(cold).toBeNull();
  });

  it('keeps municipalities independent', async () => {
    await widgetCached('acc:sofia', () => Promise.resolve('sofia'), T0);
    const other = await widgetCached('acc:varna', () => Promise.resolve('varna'), T0);
    expect(other?.value).toBe('varna');
    const sofia = await widgetCached('acc:sofia', boom, T0 + 1);
    expect(sofia?.value).toBe('sofia');
  });
});
