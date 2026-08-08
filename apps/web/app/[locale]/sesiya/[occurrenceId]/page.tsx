import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { occurrenceView } from '@/lib/sessions/occurrence';
import { siteUrl } from '@/lib/seo';

import { RsvpForm } from './rsvp-form';

/**
 * One occurrence of a play session (docs/ROADMAP.md §6, Stage 4.2).
 *
 * This is the page every notification links to — the confirmation, the
 * reminder, the cancellation — so it has to answer three questions without a
 * sign-in: what is on, where, and is it still happening. RSVP needs an account;
 * reading does not.
 *
 * NO ATTENDEE LIST, and that is a decision rather than an omission. Migration
 * 0008 left "who may see who is coming" to the UI, and the answer is nobody: a
 * public page naming people next to a place and a recurring time publishes
 * where they reliably are on a Tuesday evening. Counts, plus the viewer's own
 * place in the queue. The organiser is named, because organising a session
 * strangers are invited to is a public act and somebody has to be answerable.
 *
 * noindex: a session is an eight-week-lived URL, and indexing it would leave
 * search results full of evenings that already happened.
 */

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageParams = Promise<{ locale: string; occurrenceId: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, occurrenceId } = await params;
  if (!UUID_RE.test(occurrenceId)) return { robots: { index: false, follow: false } };
  const view = await occurrenceView(occurrenceId, null);
  if (!view) return { robots: { index: false, follow: false } };
  const t = await getTranslations({ locale, namespace: 'Session' });
  return {
    title: t('metaTitle', { title: view.title }),
    description: t('metaDescription', {
      title: view.title,
      facility: view.facilityName ?? '',
    }),
    robots: { index: false, follow: false },
  };
}

function timeOf(startsAtLocal: string): string {
  return (startsAtLocal.split('T')[1] ?? '').slice(0, 5);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3 border-b border-neutral-100 py-2 text-sm last:border-0">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

export default async function SessionPage({ params }: { params: PageParams }) {
  const { locale, occurrenceId } = await params;
  setRequestLocale(locale);
  if (!UUID_RE.test(occurrenceId)) notFound();

  const user = await getCurrentUser();
  const view = await occurrenceView(occurrenceId, user?.id ?? null);
  if (!view) notFound();

  const [t, tSport, tSkill, tCheckin] = await Promise.all([
    getTranslations('Session'),
    getTranslations('Sport'),
    getTranslations('SessionSkill'),
    getTranslations('Checkin'),
  ]);

  const dayFormat = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const day = dayFormat.format(new Date(`${view.startsAtLocal.split('T')[0] ?? ''}T00:00:00Z`));

  const spots =
    view.capacity === null
      ? t('spotsUnlimited', { going: view.going })
      : t('spots', { going: view.going, capacity: view.capacity });

  // Closed once it has started or been cancelled — the database refuses the
  // RSVP either way, so this only decides what the page offers.
  const open = !view.cancelled && !view.started;
  const icsUrl = `${siteUrl()}/kalendar/sesiya/${view.occurrenceId}.ics`;

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4">
      {view.facilitySlug && (
        <Link href={`/obekt/${view.facilitySlug}`} className="text-sm underline">
          {t('backToFacility')}
        </Link>
      )}

      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">{view.title}</h1>
        {view.cancelled && (
          <p role="status" className="rounded border border-red-200 bg-red-50 p-3 text-red-800">
            {t('cancelledNotice')}
          </p>
        )}
        {!view.cancelled && view.started && (
          <p className="rounded border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
            {t('startedNotice')}
          </p>
        )}
      </header>

      <dl className="rounded-lg border border-neutral-200 px-4 py-1">
        <Row label={t('labelWhen')}>
          {/* first-letter, not `capitalize`: Bulgarian month names are
              lowercase, and capitalizing every word turns "24 юли 2026 г." into
              "24 Юли 2026 Г." */}
          <span className="inline-block first-letter:uppercase">{day}</span>,{' '}
          {timeOf(view.startsAtLocal)} ({t('durationMinutes', { minutes: view.durationMinutes })})
        </Row>
        <Row label={t('labelWhere')}>
          {view.facilitySlug && view.facilityName ? (
            <Link href={`/obekt/${view.facilitySlug}`} className="underline">
              {view.facilityName}
            </Link>
          ) : (
            (view.facilityName ?? '—')
          )}
        </Row>
        <Row label={t('labelSport')}>
          {tSport(view.sport)} · {tSkill(view.skillLevel)}
        </Row>
        <Row label={t('labelSpots')}>
          {spots}
          {view.waitlisted > 0 && (
            <span className="text-neutral-500"> · {t('waitlisted', { n: view.waitlisted })}</span>
          )}
        </Row>
        {view.organizerName && <Row label={t('labelOrganizer')}>{view.organizerName}</Row>}
      </dl>

      {view.description && (
        <p className="whitespace-pre-line text-neutral-700">{view.description}</p>
      )}

      {open && (
        <section aria-labelledby="rsvp-h" className="space-y-3">
          <h2 id="rsvp-h" className="text-lg font-semibold">
            {t('rsvpHeading')}
          </h2>
          {user ? (
            <>
              {view.viewerStatus && (
                <p className="text-sm text-neutral-700">
                  {view.viewerStatus === 'going'
                    ? t('youAreGoing')
                    : t('youAreWaitlisted', { position: view.viewerPosition ?? 0 })}
                </p>
              )}
              <RsvpForm
                occurrenceId={view.occurrenceId}
                attending={view.viewerStatus !== null}
                labels={{
                  join: t('join'),
                  joinFull: t('joinFull'),
                  leave: t('leave'),
                  pending: t('pending'),
                  genericError: t('error.generic'),
                  errors: {
                    rate_limited: t('error.rate_limited'),
                    not_attending: t('error.not_attending'),
                    occurrence_cancelled: t('error.occurrence_cancelled'),
                    occurrence_started: t('error.occurrence_started'),
                    occurrence_not_found: t('error.occurrence_not_found'),
                  },
                }}
              />
              {view.capacity !== null && view.going >= view.capacity && !view.viewerStatus && (
                // Joining a full session is a waitlist place, not an error —
                // say so before the button rather than after it.
                <p className="text-sm text-neutral-500">{t('fullHint')}</p>
              )}
            </>
          ) : (
            <p className="text-sm">
              <Link href="/vhod" className="underline">
                {t('signInToJoin')}
              </Link>
            </p>
          )}
        </section>
      )}

      {view.viewerIsOrganizer && !view.cancelled && (
        <section
          aria-labelledby="org-h"
          className="space-y-2 rounded border border-neutral-200 p-3"
        >
          <h2 id="org-h" className="text-sm font-semibold">
            {t('labelOrganizer')}
          </h2>
          {/* Stage 5.4. Only the organiser of THIS series sees the link, and the
              page behind it checks the same thing again against the database. */}
          <Link href={`/sesiya/${view.occurrenceId}/qr`} className="text-sm underline">
            {tCheckin('organizerLink')}
          </Link>
        </section>
      )}

      <section aria-labelledby="cal-h" className="space-y-2 border-t border-neutral-200 pt-4">
        <h2 id="cal-h" className="text-sm font-semibold">
          {t('calendarHeading')}
        </h2>
        <p className="text-sm">
          {/* A plain link, not a client download button: an .ics is a file the
              browser and the phone already know what to do with. */}
          <a href={icsUrl} className="underline">
            {t('addToCalendar')}
          </a>
        </p>
        {user && (
          <p className="text-sm text-neutral-600">
            <Link href="/profil" className="underline">
              {t('subscribeAll')}
            </Link>
          </p>
        )}
      </section>
    </main>
  );
}
