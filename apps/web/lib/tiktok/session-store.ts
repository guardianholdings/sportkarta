import { randomBytes } from 'node:crypto';

import { SlidingWindowRateLimiter } from '@/lib/rate-limit';

/**
 * Where a signed-in TikTok demo session lives: this web process's memory, and
 * nowhere else. Never the database, never a log line, never the browser — the
 * browser holds only a random 32-byte id in an httpOnly cookie, which is
 * worthless without this Map. A restart or a deploy forgets every session; the
 * reviewer just presses "Continue with TikTok" again. No new secret is needed
 * (there is nothing to encrypt or sign), and production runs one web process
 * (deploy/compose.prod.yml), so one Map is the whole store.
 *
 * Lifetime: the shorter of TikTok's expires_in and two hours. The refresh
 * token is not kept — nothing outlives the session it was issued for.
 */

export const MAX_SESSION_MS = 2 * 60 * 60 * 1000;
/** A demo for reviewers: a handful at once. The oldest goes first beyond this. */
export const MAX_SESSIONS = 50;
/** publish_ids remembered per session — /tiktok/status answers only for these. */
const MAX_PUBLISH_IDS = 10;

const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

export interface TikTokSession {
  accessToken: string;
  expiresAt: number;
  publishIds: string[];
}

export class TikTokSessionStore {
  private readonly sessions = new Map<string, TikTokSession>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Store a fresh token; returns the cookie id and its max-age in seconds. */
  create(accessToken: string, expiresInSec: number): { id: string; maxAgeSec: number } {
    this.sweep();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const tikTokMs = Number.isFinite(expiresInSec)
      ? Math.max(0, Math.floor(expiresInSec)) * 1000
      : 0;
    const ttlMs = Math.min(MAX_SESSION_MS, tikTokMs);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { accessToken, expiresAt: this.now() + ttlMs, publishIds: [] });
    return { id, maxAgeSec: Math.floor(ttlMs / 1000) };
  }

  get(id: string | null | undefined): TikTokSession | null {
    if (!id || !SESSION_ID.test(id)) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  delete(id: string | null | undefined): TikTokSession | null {
    if (!id) return null;
    const session = this.sessions.get(id) ?? null;
    this.sessions.delete(id);
    return session;
  }

  rememberPublishId(id: string, publishId: string): void {
    const session = this.get(id);
    if (!session) return;
    session.publishIds = [...session.publishIds.filter((p) => p !== publishId), publishId].slice(
      -MAX_PUBLISH_IDS,
    );
  }

  ownsPublishId(id: string | null | undefined, publishId: string): boolean {
    return this.get(id)?.publishIds.includes(publishId) ?? false;
  }

  get size(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= t) this.sessions.delete(id);
    }
  }
}

/**
 * Pinned to globalThis, like lib/form-token.ts and the export limiter: Next may
 * evaluate this module once for the page and again for each route handler, and
 * separate copies would not see each other's sessions.
 */
const globalForTikTok = globalThis as unknown as {
  __tiktokDemoSessions?: TikTokSessionStore;
  __tiktokDemoUploadBusy?: boolean;
  __tiktokDemoLimiters?: {
    start: SlidingWindowRateLimiter;
    publish: SlidingWindowRateLimiter;
    status: SlidingWindowRateLimiter;
  };
};

export function tiktokSessions(): TikTokSessionStore {
  return (globalForTikTok.__tiktokDemoSessions ??= new TikTokSessionStore());
}

/**
 * Rate limits, on the app's existing in-memory limiter. Keys are the client IP
 * (transient, never stored) or the session id. TikTok's own caps are tighter
 * still (6 post inits per minute per token, 5 posting users a day before the
 * audit); these only stop a loop from hammering the VPS or TikTok.
 */
export function tiktokLimiters() {
  return (globalForTikTok.__tiktokDemoLimiters ??= {
    start: new SlidingWindowRateLimiter(20, 10 * 60 * 1000),
    publish: new SlidingWindowRateLimiter(5, 10 * 60 * 1000),
    status: new SlidingWindowRateLimiter(60, 60 * 1000),
  });
}

/**
 * One upload at a time, process-wide: a video is held in memory for the length
 * of its request (≤ 50 MB), and a second one waits its turn rather than
 * doubling that.
 */
export function tryAcquireUploadSlot(): boolean {
  if (globalForTikTok.__tiktokDemoUploadBusy) return false;
  globalForTikTok.__tiktokDemoUploadBusy = true;
  return true;
}

export function releaseUploadSlot(): void {
  globalForTikTok.__tiktokDemoUploadBusy = false;
}
