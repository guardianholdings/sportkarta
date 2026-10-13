import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SESSION_MS,
  MAX_SESSIONS,
  releaseUploadSlot,
  TikTokSessionStore,
  tryAcquireUploadSlot,
} from '@/lib/tiktok/session-store';

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('the in-memory TikTok session store', () => {
  it('hands out a random, cookie-safe id and keeps the token server-side', () => {
    const store = new TikTokSessionStore();
    const a = store.create('token-a', 3600);
    const b = store.create('token-b', 3600);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toContain('token');
    expect(store.get(a.id)?.accessToken).toBe('token-a');
  });

  it('lives for the shorter of TikTok’s expires_in and two hours', () => {
    const store = new TikTokSessionStore();
    expect(store.create('t', 600).maxAgeSec).toBe(600);
    expect(store.create('t', 86_400).maxAgeSec).toBe(MAX_SESSION_MS / 1000);
    expect(store.create('t', Number.NaN).maxAgeSec).toBe(0);
    expect(store.create('t', -5).maxAgeSec).toBe(0);
  });

  it('forgets a session once it expires', () => {
    const c = clock();
    const store = new TikTokSessionStore(c.now);
    const { id } = store.create('t', 60);
    c.advance(59_000);
    expect(store.get(id)).not.toBeNull();
    c.advance(1_000);
    expect(store.get(id)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('ignores ids that could not have come from it', () => {
    const store = new TikTokSessionStore();
    store.create('t', 60);
    for (const id of [
      undefined,
      null,
      '',
      'short',
      'x'.repeat(44),
      '../../etc/passwd'.padEnd(43, 'a'),
    ]) {
      expect(store.get(id)).toBeNull();
    }
  });

  it('deletes on sign-out and returns what it deleted', () => {
    const store = new TikTokSessionStore();
    const { id } = store.create('t', 60);
    expect(store.delete(id)?.accessToken).toBe('t');
    expect(store.get(id)).toBeNull();
    expect(store.delete(id)).toBeNull();
    expect(store.delete(undefined)).toBeNull();
  });

  it('caps the number of sessions, dropping the oldest', () => {
    const store = new TikTokSessionStore();
    const first = store.create('first', 60).id;
    for (let i = 0; i < MAX_SESSIONS; i++) store.create(`t${i}`, 60);
    expect(store.size).toBe(MAX_SESSIONS);
    expect(store.get(first)).toBeNull();
  });

  it('answers status lookups only for posts the session itself started', () => {
    const store = new TikTokSessionStore();
    const mine = store.create('t', 60).id;
    const other = store.create('u', 60).id;
    store.rememberPublishId(mine, 'v_pub_1');
    expect(store.ownsPublishId(mine, 'v_pub_1')).toBe(true);
    expect(store.ownsPublishId(other, 'v_pub_1')).toBe(false);
    expect(store.ownsPublishId(undefined, 'v_pub_1')).toBe(false);
    for (let i = 0; i < 12; i++) store.rememberPublishId(mine, `v_pub_x${i}`);
    expect(store.ownsPublishId(mine, 'v_pub_1')).toBe(false);
    expect(store.get(mine)?.publishIds).toHaveLength(10);
  });
});

describe('one upload at a time', () => {
  afterEach(() => releaseUploadSlot());

  it('refuses a second upload until the first one is done', () => {
    expect(tryAcquireUploadSlot()).toBe(true);
    expect(tryAcquireUploadSlot()).toBe(false);
    releaseUploadSlot();
    expect(tryAcquireUploadSlot()).toBe(true);
  });
});
