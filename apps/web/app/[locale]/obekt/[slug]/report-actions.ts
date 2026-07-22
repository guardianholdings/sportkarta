'use server';

import { randomUUID } from 'node:crypto';

import { getDb, sql } from '@sportkarta/db';
import { headers } from 'next/headers';

import { verifyFormToken } from '@/lib/form-token';
import { InvalidPhotoError, MAX_PHOTO_BYTES, processReportPhoto } from '@/lib/image';
import { clientIpFromForwardedFor } from '@/lib/rate-limit';
import { reportRateLimiter } from '@/lib/report-rate-limit';
import { getStorage } from '@/lib/storage';

// First public WRITE path. Every input is untrusted; validate server-side and
// layer anti-spam (honeypot + min-time + per-IP rate limit) without a captcha.
// The IP is used only for rate-limiting and is NEVER stored with the report.

const ISSUES = new Set([
  'broken_equipment',
  'no_lighting',
  'bad_surface',
  'does_not_exist',
  'other',
]);
const MIN_FORM_MS = 3_000; // faster than a human could read+fill => bot
const MAX_FORM_MS = 2 * 60 * 60 * 1000; // stale/replayed form
const MAX_BODY = 500;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `error` is an i18n key suffix under the Report namespace (Report.error.*). */
export interface ReportState {
  status: 'idle' | 'ok' | 'error';
  error?: string;
}

export async function submitReport(_prev: ReportState, formData: FormData): Promise<ReportState> {
  // 1) Honeypot — a hidden field only bots fill. Pretend success so we don't
  //    reveal the trap; nothing is written.
  const honeypot = formData.get('website');
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    return { status: 'ok' };
  }

  // 2) Min-time-on-form using the HMAC-signed, server-issued timestamp (a bot
  //    cannot forge the signature to skip the delay).
  const issuedAt = verifyFormToken(formData.get('ts') as string | null);
  const elapsed = issuedAt === null ? -1 : Date.now() - issuedAt;
  if (issuedAt === null || elapsed < MIN_FORM_MS || elapsed > MAX_FORM_MS) {
    return { status: 'error', error: 'tooFast' };
  }

  // 3) Per-IP sliding-window rate limit. IP comes from Caddy's X-Forwarded-For
  //    (rightmost hop) and is discarded after this check — never persisted.
  const ip = clientIpFromForwardedFor((await headers()).get('x-forwarded-for')) ?? 'unknown';
  if (!reportRateLimiter.check(ip).allowed) {
    return { status: 'error', error: 'rateLimited' };
  }

  // 4) Validate the structured fields.
  const issue = String(formData.get('issue') ?? '');
  if (!ISSUES.has(issue)) return { status: 'error', error: 'invalid' };

  const bodyRaw = String(formData.get('body') ?? '').trim();
  if (bodyRaw.length > MAX_BODY) return { status: 'error', error: 'invalid' };
  const body = bodyRaw.length > 0 ? bodyRaw : null;

  const slug = String(formData.get('slug') ?? '');
  if (!SLUG_RE.test(slug)) return { status: 'error', error: 'invalid' };

  // Resolve the facility from the slug server-side (never trust a client id).
  const db = getDb();
  const facRes = await db.execute(
    sql`SELECT id FROM facilities WHERE slug = ${slug} AND status <> 'gone'`,
  );
  const facilityId = (facRes.rows[0] as { id?: string } | undefined)?.id;
  if (!facilityId) return { status: 'error', error: 'invalid' };

  // 5) Optional photo: validate + EXIF-strip + re-encode, then store the file.
  //    (Filesystem write happens before the DB tx; on tx failure we clean it up.)
  let storedKey: string | null = null;
  const file = formData.get('photo');
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_PHOTO_BYTES) return { status: 'error', error: 'photoTooLarge' };
    let processed;
    try {
      processed = await processReportPhoto(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      if (error instanceof InvalidPhotoError) return { status: 'error', error: 'invalidPhoto' };
      throw error;
    }
    const now = new Date();
    storedKey = `reports/${String(now.getUTCFullYear())}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${processed.extension}`;
    await getStorage().put(storedKey, processed.data, { contentType: processed.contentType });
  }

  // 6) Persist the photo row + report atomically (a mid-write failure must not
  //    orphan a pending photo with no parent report). photo_id references the
  //    photo of the same facility (app-level invariant).
  try {
    await db.transaction(async (tx) => {
      let photoId: string | null = null;
      if (storedKey) {
        const photoRes = await tx.execute(sql`
          INSERT INTO facility_photos (facility_id, storage_path, status, uploaded_by)
          VALUES (${facilityId}, ${storedKey}, 'pending', NULL)
          RETURNING id
        `);
        photoId = (photoRes.rows[0] as { id?: string } | undefined)?.id ?? null;
      }
      await tx.execute(sql`
        INSERT INTO facility_reports (facility_id, issue, body, photo_id, status)
        VALUES (${facilityId}, ${issue}::report_issue, ${body}, ${photoId}, 'pending')
      `);
    });
  } catch (error) {
    // Roll the stored file back so it can't dangle without a DB row.
    if (storedKey)
      await getStorage()
        .delete(storedKey)
        .catch(() => undefined);
    throw error;
  }

  return { status: 'ok' };
}
