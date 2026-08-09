import { getDb, sql } from '@sportkarta/db';
import { issueCheckinToken, msUntilNextWindow, WINDOW_MS } from '@sportkarta/lib/checkin-token';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';

import { requireUser } from '@/lib/auth-session';
import { checkinSecret } from '@/lib/checkin-config';
import { siteUrl } from '@/lib/seo';

/**
 * The organiser's check-in screen (docs/ROADMAP.md §7, Stage 5.4).
 *
 * A QR code holding a signed token that changes every minute. The organiser
 * holds their phone up; members scan it; the token proves they were close
 * enough to read that screen within the last two minutes. That is the whole
 * security claim — see lib/sessions/checkin.ts for the honest limits of it.
 *
 * NO CLIENT JAVASCRIPT. The QR is an SVG rendered on the server, and the page
 * refreshes itself with `<meta http-equiv="refresh">` timed to the end of the
 * current window. A React interval would work too, and would also stop working
 * the moment the organiser's phone slept, backgrounded the tab, or lost the
 * hydration bundle on park wifi. A meta refresh survives all three.
 *
 * ORGANISER OR ADMIN ONLY, checked against the database. Anybody who can see
 * this page can mint check-ins for the session, so the gate here is the same
 * one that guards cancelling it.
 */

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageParams = Promise<{ locale: string; occurrenceId: string }>;

export const metadata = { robots: { index: false, follow: false } };

interface OrganizerView {
  title: string;
  startsAtLocal: string;
  checkedIn: number;
  going: number;
}

async function organizerView(occurrenceId: string, actorId: string): Promise<OrganizerView | null> {
  const result = await getDb().execute(sql`
    SELECT s.title,
           to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
           (SELECT count(*)::int FROM play_session_checkins c WHERE c.occurrence_id = o.id)
             AS checked_in,
           (SELECT count(*)::int FROM play_session_rsvp_positions p
             WHERE p.occurrence_id = o.id AND p.rsvp_status = 'going') AS going
      FROM play_session_occurrences o
      JOIN play_sessions s ON s.id = o.session_id
     WHERE o.id = ${occurrenceId}::uuid
       AND o.status = 'scheduled'
       -- The authority is read from the database in the same statement, never
       -- taken from the caller. Admins can stand in for an absent organiser.
       AND (s.organizer_id = ${actorId}
            OR EXISTS (SELECT 1 FROM users u WHERE u.id = ${actorId} AND u.role = 'admin'))
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    title: String(row.title),
    startsAtLocal: String(row.starts_at_local),
    checkedIn: Number(row.checked_in ?? 0),
    going: Number(row.going ?? 0),
  };
}

export default async function CheckinQrPage({ params }: { params: PageParams }) {
  const { locale, occurrenceId } = await params;
  setRequestLocale(locale);
  if (!UUID_RE.test(occurrenceId)) notFound();

  const user = await requireUser();
  const view = await organizerView(occurrenceId, user.id);
  // A 404 rather than a "forbidden": somebody who does not organise this
  // session has no business learning that its check-in screen exists.
  if (!view) notFound();

  const t = await getTranslations('Checkin');
  const secret = checkinSecret();

  if (!secret) {
    // Fail closed and say so plainly to the one person who can report it.
    return (
      <main className="mx-auto max-w-md space-y-4 p-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{view.title}</h1>
        <p
          role="alert"
          className="rounded border border-warning-border bg-warning-bg p-3 text-warning"
        >
          {t('disabled')}
        </p>
      </main>
    );
  }

  const now = new Date();
  const token = issueCheckinToken({ occurrenceId, secret, at: now });
  const url = `${siteUrl().replace(/\/+$/, '')}/otmetka/${token}`;
  // Rendered as an SVG string rather than a data-URI PNG: it scales to any
  // screen without blurring, which matters when somebody is scanning it from
  // two metres away in the sun.
  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
  // Refresh a second after this window ends, so the page never serves a token
  // that expired while somebody was walking over.
  const refreshSeconds = Math.ceil(msUntilNextWindow(now) / 1000) + 1;

  return (
    <main className="mx-auto max-w-md space-y-4 p-4 text-center">
      <meta httpEquiv="refresh" content={String(refreshSeconds)} />

      <header className="space-y-1">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{view.title}</h1>
        <p className="text-body-sm text-text-muted">
          {t('attendance', { checkedIn: view.checkedIn, going: view.going })}
        </p>
      </header>

      {/* The only markup injection in the app, and it is safe by construction:
          the string comes from the qrcode library encoding a URL WE built from
          our own site base and our own HMAC. No user input reaches it — the
          occurrence id is regex-checked above, and the token is generated, not
          received. Inlining the SVG is what keeps the code crisp at any size. */}
      <div className="mx-auto w-full max-w-[320px]" dangerouslySetInnerHTML={{ __html: svg }} />

      <p className="text-body-sm text-ink-soft">{t('scanHint')}</p>
      <p className="text-caption text-text-muted">
        {t('rotates', { seconds: Math.round(WINDOW_MS / 1000) })}
      </p>
      <p className="text-caption text-text-faint">{t('keepScreenOn')}</p>
    </main>
  );
}
