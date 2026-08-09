import { readFileSync } from 'node:fs';

import {
  claimDigestSend,
  digestRecipients,
  formatWeekStart,
  getDb,
  weeklyDigest,
  weekStartFor,
  sql as sqlTemplate,
  type DigestRecipient,
} from '@sportkarta/db';
import { assignCitySlugs, cityDisplayName, type MunicipalityRow } from '@sportkarta/lib/cities';
import { renderWeeklyDigest, type DigestStrings, type Mailer } from '@sportkarta/lib/email';
import { SOFIA_TZ } from '@sportkarta/lib/recurrence';

/**
 * The Monday weekly-digest send (docs/ROADMAP.md §6, Stage 4.4).
 *
 * The page at /sedmitsata/[city] and this job call the SAME query —
 * `weeklyDigest` from @sportkarta/db — so what a member reads in the mail is
 * what they find when they follow the link. That is why the query lives in the
 * db package rather than in apps/web/lib, which the worker cannot import.
 *
 * IDEMPOTENCY. For each subscriber, in ONE transaction: claim the week in
 * `digest_sends` first, and send only if the claim inserted a row. A retried
 * job, an overlapping schedule or a second worker therefore cannot mail anyone
 * twice. The one hole is a crash between the SMTP handoff and COMMIT, which
 * re-sends that week — the right way round, since send-then-record loses mail
 * silently instead.
 *
 * NO PII IN LOGS: counts only. The address is read at send time and never put
 * into a job payload that would outlive the account it names.
 */

const MESSAGES_BY_LOCALE = new Map<string, Record<string, Record<string, string>>>();

/**
 * The message catalogue is `apps/web/messages/<locale>.json` — the source of
 * truth per CLAUDE.md, so the email and the page say the same words and the
 * i18n parity test covers the email too. Resolved by workspace-relative URL,
 * the same technique index.ts already uses for the repo-root .env; the worker
 * image contains the whole workspace (see the Dockerfile's worker stage).
 */
function messages(locale: string): Record<string, Record<string, string>> {
  const cached = MESSAGES_BY_LOCALE.get(locale);
  if (cached) return cached;
  const url = new URL(`../../../apps/web/messages/${locale}.json`, import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as Record<string, Record<string, string>>;
  MESSAGES_BY_LOCALE.set(locale, parsed);
  return parsed;
}

/** Translated sport labels, from the same catalogue the page uses. */
export function sportLabels(locale: string): Record<string, string> {
  return messages(locale).Sport ?? {};
}

export function digestStrings(locale: string): DigestStrings {
  const ns = messages(locale).DigestEmail ?? {};
  // Throw rather than fall back to the key: a renamed message would otherwise
  // ship the literal string "subject" as the Subject line to every subscriber,
  // and the bg↔en parity test cannot see that.
  const pick = (key: string): string => {
    const value = ns[key];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`DigestEmail.${key} is missing from messages/${locale}.json`);
    }
    return value;
  };
  return {
    subject: pick('subject'),
    greeting: pick('greeting'),
    introOne: pick('introOne'),
    introOther: pick('introOther'),
    weekdays: [
      pick('monday'),
      pick('tuesday'),
      pick('wednesday'),
      pick('thursday'),
      pick('friday'),
      pick('saturday'),
      pick('sunday'),
    ],
    spots: pick('spots'),
    spotsUnlimited: pick('spotsUnlimited'),
    viewWeek: pick('viewWeek'),
    unsubscribe: pick('unsubscribe'),
    footer: pick('footer'),
  };
}

export interface DigestRunOptions {
  now?: Date;
  /** Absolute site base, e.g. https://pops.bg. */
  siteUrl: string;
  locale?: string;
  mailer: Mailer;
}

export interface DigestRunReport {
  subscribers: number;
  sent: number;
  /** Already sent this week, or the city had nothing on. */
  skipped: number;
  failed: number;
}

/** municipality id → URL slug, resolved exactly as the web app resolves it. */
async function citySlugs(db: ReturnType<typeof getDb>): Promise<Map<number, string>> {
  const result = await db.execute(
    sqlTemplate`SELECT id, name_bg, name_en FROM municipalities ORDER BY id`,
  );
  const cities = assignCitySlugs(result.rows as unknown as MunicipalityRow[]);
  return new Map(cities.map((city) => [city.id, city.slug]));
}

const DIGEST_FAILURE_LOG = 'digest.weekly recipient failed:';

/**
 * A coarse, address-free classification. Postgres and nodemailer both put an
 * error `code` on the object; anything else collapses to 'send_failed'.
 */
function failureCategory(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
  }
  return 'send_failed';
}

export async function runWeeklyDigest(options: DigestRunOptions): Promise<DigestRunReport> {
  const db = getDb();
  const now = options.now ?? new Date();
  const locale = options.locale ?? 'bg';
  const strings = digestStrings(locale);
  const sports = sportLabels(locale);
  const weekStart = weekStartFor(now, SOFIA_TZ);
  const weekStartDate = formatWeekStart(weekStart);

  const report: DigestRunReport = { subscribers: 0, sent: 0, skipped: 0, failed: 0 };
  const recipients = await digestRecipients(db);
  report.subscribers = recipients.length;
  // The same slug assignment the web app serves (@sportkarta/lib/cities), over
  // the same stable ordering — so the link in the email is the URL that exists.
  const slugByCity = await citySlugs(db);

  // One digest per city, reused across its subscribers — the week does not
  // change between two people.
  const weeks = new Map<number, Awaited<ReturnType<typeof weeklyDigest>>>();

  for (const recipient of recipients) {
    try {
      let week = weeks.get(recipient.municipalityId);
      if (!week) {
        week = await weeklyDigest(db, {
          municipalityId: recipient.municipalityId,
          weekStart,
          timeZone: SOFIA_TZ,
        });
        weeks.set(recipient.municipalityId, week);
      }
      // A mail that says "nothing is on" is not worth an inbox.
      if (week.occurrences.length === 0) {
        report.skipped += 1;
        continue;
      }
      const delivered = await sendOne(db, recipient, week, weekStartDate, strings, options, {
        slug: slugByCity.get(recipient.municipalityId) ?? '',
        // The override-aware display name — "София", not the municipality's
        // legal name "Столична", which is what the page shows too.
        name: cityDisplayName(recipient.municipalityNameBg, recipient.municipalityNameEn, locale),
        sports,
      });
      if (delivered) report.sent += 1;
      else report.skipped += 1;
    } catch (error: unknown) {
      report.failed += 1;
      // A CATEGORY, never the message. An SMTP rejection reads
      // "550 5.1.1 <ivan@example.org>: Recipient address rejected" — logging
      // `error.message` would write every bounced address into the container
      // log on the first Monday with a stale subscriber list. The counts in the
      // report are what an operator acts on; the address is never needed.
      console.error(`[worker] ${DIGEST_FAILURE_LOG} ${failureCategory(error)}`);
    }
  }

  return report;
}

async function sendOne(
  db: ReturnType<typeof getDb>,
  recipient: DigestRecipient,
  week: Awaited<ReturnType<typeof weeklyDigest>>,
  weekStartDate: string,
  strings: DigestStrings,
  options: DigestRunOptions,
  city: { slug: string; name: string; sports: Record<string, string> },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Claim FIRST: if this returns false somebody already sent this week.
    const claimed = await claimDigestSend(
      tx,
      recipient.userId,
      recipient.municipalityId,
      weekStartDate,
    );
    if (!claimed) return false;

    const base = options.siteUrl.replace(/\/+$/, '');
    const citySlugPath = `${base}/sedmitsata/${city.slug}`;
    const message = renderWeeklyDigest(
      {
        cityName: city.name,
        recipientName: recipient.displayName,
        entries: week.occurrences.map((occurrence) => ({
          startsAtLocal: occurrence.startsAtLocal,
          title: occurrence.title,
          sport: city.sports[occurrence.sport] ?? occurrence.sport,
          facilityName: occurrence.facilityName ?? '',
          facilityUrl: occurrence.facilitySlug
            ? `${base}/obekt/${occurrence.facilitySlug}`
            : undefined,
          capacity: occurrence.capacity,
          going: occurrence.going,
        })),
        weekUrl: citySlugPath,
        unsubscribeUrl: `${base}/sedmitsata/otpisvane/${recipient.unsubscribeToken}`,
      },
      strings,
    );
    if (!message) {
      // Nothing to say after all. Undo the claim so a later run can try again.
      tx.rollback();
      return false;
    }

    // Inside the transaction, deliberately: a throw here rolls the claim back,
    // so a failed send is retried next run rather than silently swallowed.
    await options.mailer.send({ ...message, to: recipient.email });
    return true;
  });
}
