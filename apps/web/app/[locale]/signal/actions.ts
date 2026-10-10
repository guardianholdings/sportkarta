'use server';

import { getDb } from '@sportkarta/db';
import { headers } from 'next/headers';

import { checkFormToken, issueFormToken } from '@/lib/form-token';
import { enqueueModerationNotify } from '@/lib/moderation-notify';
import { parseNotice, type NoticeProblem } from '@/lib/notice-input';
import { noticeRateLimiter } from '@/lib/notice-rate-limit';
import { insertNotice } from '@/lib/notices';
import { clientIpFromForwardedFor } from '@/lib/rate-limit';

/**
 * Submit a notice from /signal (DSA Art. 16, migration 0034).
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

/** `error` is an i18n key suffix under `Notice.error`. */
export interface NoticeState {
  status: 'idle' | 'ok' | 'error';
  error?: NoticeProblem | 'tooFast' | 'expired' | 'rateLimited';
  /**
   * A replacement token, handed out with `expired` only — see submitReport,
   * whose answer this now mirrors.
   */
  formToken?: string;
}

export async function submitNotice(_prev: NoticeState, formData: FormData): Promise<NoticeState> {
  // Honeypot: pretend success so the trap is not revealed; nothing is written.
  const honeypot = formData.get('website');
  if (typeof honeypot === 'string' && honeypot.trim() !== '') return { status: 'ok' };

  // "Too fast" is cured by waiting, so the same token is retried. A stale token
  // (the page was open over two hours) can never pass: it used to get the same
  // «too fast» answer and an instruction to reload — which threw away an
  // explanation of up to 2,000 characters. It now gets a fresh token instead,
  // issued NOW, so the minimum time still applies (UX audit 2026-10-10).
  const submittedToken = formData.get('ts');
  const verdict = checkFormToken(typeof submittedToken === 'string' ? submittedToken : null);
  if (!verdict.ok) {
    return verdict.reason === 'tooFast'
      ? { status: 'error', error: 'tooFast' }
      : { status: 'error', error: 'expired', formToken: issueFormToken() };
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
