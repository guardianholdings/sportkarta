'use server';

import { getDb } from '@sportkarta/db';
import { headers } from 'next/headers';

import { verifyFormToken } from '@/lib/form-token';
import { enqueueModerationNotify } from '@/lib/moderation-notify';
import { parseNotice, type NoticeProblem } from '@/lib/notice-input';
import { noticeRateLimiter } from '@/lib/notice-rate-limit';
import { insertNotice } from '@/lib/notices';
import { clientIpFromForwardedFor } from '@/lib/rate-limit';

/**
 * Submit a notice from /signal (DSA Art. 16, migration 0033).
 *
 * ANONYMOUS BY DEFAULT, with the facility report's anti-spam layers and no
 * captcha: a honeypot, a signed minimum-time token and a per-IP rate limit of
 * its own. The IP decides the rate limit and is then forgotten — it is never
 * stored with the notice, and nothing about the sender is kept that the form
 * did not ask for.
 *
 * The receipt (Art. 16(4)) is the worker's job, and only when the notifier left
 * an address. It is enqueued after the insert committed, best effort: a notice
 * that was stored but not acknowledged is still a notice we must decide.
 */

const MIN_FORM_MS = 3_000;
const MAX_FORM_MS = 2 * 60 * 60 * 1000;

/** `error` is an i18n key suffix under `Notice.error`. */
export interface NoticeState {
  status: 'idle' | 'ok' | 'error';
  error?: NoticeProblem | 'tooFast' | 'rateLimited';
}

export async function submitNotice(_prev: NoticeState, formData: FormData): Promise<NoticeState> {
  // Honeypot: pretend success so the trap is not revealed; nothing is written.
  const honeypot = formData.get('website');
  if (typeof honeypot === 'string' && honeypot.trim() !== '') return { status: 'ok' };

  const issuedAt = verifyFormToken(formData.get('ts') as string | null);
  const elapsed = issuedAt === null ? -1 : Date.now() - issuedAt;
  if (issuedAt === null || elapsed < MIN_FORM_MS || elapsed > MAX_FORM_MS) {
    return { status: 'error', error: 'tooFast' };
  }

  const ip = clientIpFromForwardedFor((await headers()).get('x-forwarded-for')) ?? 'unknown';
  if (!noticeRateLimiter.check(ip).allowed) return { status: 'error', error: 'rateLimited' };

  const parsed = parseNotice({
    url: formData.get('url'),
    category: formData.get('category'),
    explanation: formData.get('explanation'),
    name: formData.get('name'),
    email: formData.get('email'),
    goodFaith: formData.get('goodFaith'),
  });
  if (!parsed.ok) return { status: 'error', error: parsed.problem };

  const noticeId = await insertNotice(getDb(), parsed.value);
  if (noticeId && parsed.value.notifierEmail) {
    await enqueueModerationNotify({ kind: 'notice_received', noticeId });
  }
  return { status: 'ok' };
}
