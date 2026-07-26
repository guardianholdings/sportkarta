import { getDb } from '@sportkarta/db';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { requireUser } from '@/lib/auth-session';
import {
  CHECKIN_CLOSES_AFTER_MINUTES,
  CHECKIN_OPENS_BEFORE_MINUTES,
} from '@/lib/sessions/checkin';
import { SessionError } from '@/lib/sessions/errors';
import { occurrenceRoster, type OccurrenceRoster } from '@/lib/sessions/roster';
import { Link } from '@/i18n/navigation';

import { markPresentAction } from './actions';

/**
 * The organiser's roster deck (Stage 4.3): who signed up, who is here, and a
 * button to vouch for the people the QR flow missed.
 *
 * Same envelope as the QR screen next door: organiser-or-admin gated against
 * the database, 404 for everybody else, no AppShell (it is a screen held in a
 * hand at the pitch), and a meta refresh instead of client JavaScript, so QR
 * check-ins landing while the phone sits on a bench still appear.
 */
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFRESH_SECONDS = 60;

type PageParams = Promise<{ locale: string; occurrenceId: string }>;

function formatLocal(startsAtLocal: string): string {
  return startsAtLocal.replace('T', ' · ').slice(0, 18);
}

export default async function RosterPage({ params }: { params: PageParams }) {
  const { locale, occurrenceId } = await params;
  setRequestLocale(locale);
  if (!UUID_RE.test(occurrenceId)) notFound();

  const user = await requireUser();
  let roster: OccurrenceRoster;
  try {
    roster = await occurrenceRoster(getDb(), user.id, occurrenceId);
  } catch (error: unknown) {
    // A 404 rather than a forbidden: an outsider learns nothing, exactly like
    // the QR screen.
    if (error instanceof SessionError) notFound();
    throw error;
  }

  const t = await getTranslations('Roster');
  const going = roster.members.filter((m) => m.rsvpStatus === 'going');
  const waitlisted = roster.members.filter((m) => m.rsvpStatus === 'waitlisted');
  // Buttons only while checkIn would accept the write — the deck never offers
  // an action the domain function refuses, and outside the window it says why.
  const canMark = !roster.cancelled && roster.checkinOpen;

  const methodLabel = (method: 'self' | 'organizer' | 'qr') => t(`method.${method}`);

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      {/* No client JS on purpose — see the file comment. */}
      <meta httpEquiv="refresh" content={String(REFRESH_SECONDS)} />

      <Link
        href={`/sesiya/${roster.occurrenceId}`}
        className="text-body-sm font-medium text-link hover:text-link-hover"
      >
        {t('backToSession')}
      </Link>

      <header className="space-y-1">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{roster.title}</h1>
        <p className="text-body-sm text-text-muted">
          <span className="font-mono tabular-nums">{formatLocal(roster.startsAtLocal)}</span>
        </p>
        <p className="text-body-sm text-text-muted">
          {t('attendance', { checkedIn: roster.checkedInCount, going: going.length })}
        </p>
        {roster.cancelled && (
          <p
            role="status"
            className="rounded-card border border-danger-border bg-danger-bg p-2 text-body-sm text-danger"
          >
            {t('cancelledNotice')}
          </p>
        )}
        {!roster.cancelled && !roster.checkinOpen && (
          <p className="text-caption text-text-faint">
            {t('checkinClosedHint', {
              opens: CHECKIN_OPENS_BEFORE_MINUTES,
              closes: CHECKIN_CLOSES_AFTER_MINUTES / 60,
            })}
          </p>
        )}
      </header>

      {roster.members.length === 0 && roster.walkIns.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-4 py-8 text-center text-body-sm text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <section aria-labelledby="roster-h" className="space-y-2">
          <h2 id="roster-h" className="text-h4 font-bold text-ink">
            {t('signedUp')}
          </h2>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {roster.members.map((member) => (
              <li key={member.userId} className="flex items-center gap-3 p-3">
                <span className="w-6 shrink-0 text-right font-mono text-body-sm tabular-nums text-text-muted">
                  {member.position}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink">
                  {member.displayName ?? t('unnamedMember')}
                </span>
                {member.rsvpStatus === 'waitlisted' && (
                  <Badge tone="warning" variant="soft">
                    {t('waitlisted')}
                  </Badge>
                )}
                {member.checkinMethod ? (
                  <Badge tone="success" variant="soft">
                    {methodLabel(member.checkinMethod)}
                  </Badge>
                ) : canMark ? (
                  <form action={markPresentAction.bind(null, roster.occurrenceId, member.userId)}>
                    <button
                      type="submit"
                      className="rounded-pill border border-line-strong bg-surface px-3 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2"
                    >
                      {t('markPresent')}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {waitlisted.length > 0 && (
            <p className="text-caption text-text-faint">{t('waitlistHint')}</p>
          )}
        </section>
      )}

      {roster.walkIns.length > 0 && (
        <section aria-labelledby="walkins-h" className="space-y-2">
          <h2 id="walkins-h" className="text-h4 font-bold text-ink">
            {t('walkIns')}
          </h2>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {roster.walkIns.map((person) => (
              <li key={person.userId} className="flex items-center gap-3 p-3">
                <span className="min-w-0 flex-1 truncate text-ink">
                  {person.displayName ?? t('unnamedMember')}
                </span>
                <Badge tone="success" variant="soft">
                  {methodLabel(person.checkinMethod)}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-center">
        <Link
          href={`/sesiya/${roster.occurrenceId}/qr`}
          className="text-body-sm font-medium text-link hover:text-link-hover"
        >
          {t('showQr')}
        </Link>
      </p>
    </main>
  );
}
