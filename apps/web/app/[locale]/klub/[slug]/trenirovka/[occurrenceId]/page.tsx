import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { isUuid } from '@/lib/clubs/input';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { portalView } from '@/lib/clubs/portal';
import { publicOccurrence } from '@/lib/clubs/public';
import { formatDateTime, intlLocale } from '@/lib/format';
import { signInHref } from '@/lib/sign-in-destination';
import { cn } from '@/lib/utils';

import { portalOpAction } from '../../az/actions';
import { trialAction } from './actions';

export const dynamic = 'force-dynamic';

const GOOD = new Set(['booked', 'waitlisted']);

type PageParams = Promise<{ locale: string; slug: string; occurrenceId: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, slug, occurrenceId } = await params;
  if (!clubsEnabled() || !isUuid(occurrenceId)) return {};
  const occurrence = await publicOccurrence(slug, occurrenceId, locale);
  // One occurrence of a class is not worth indexing; the club page is.
  return {
    title: occurrence ? `${occurrence.title} — ${occurrence.clubName}` : undefined,
    robots: { index: false, follow: true },
  };
}

/**
 * One class, publicly: when, where, who leads it, how full it is — counts,
 * never names — and the one action that fits the viewer: book (a linked
 * member, for themselves or a child), a trial (anyone signed in, if the class
 * allows one), or sign in first.
 */
export default async function PublicClassPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, occurrenceId } = await params;
  setRequestLocale(locale);
  if (!clubsEnabled() || !isUuid(occurrenceId)) notFound();
  const occurrence = await publicOccurrence(slug, occurrenceId, locale);
  if (!occurrence) notFound();
  const { rezultat } = await searchParams;
  const user = await getCurrentUser();
  const [t, sportLabel, view] = await Promise.all([
    getTranslations('ClubPublic'),
    clubSportLabeler(),
    user ? portalView(user.id, slug, locale) : Promise.resolve(null),
  ]);
  const now = Date.now();
  const started = Date.parse(occurrence.startsAt) <= now;
  const open = Date.parse(occurrence.bookingOpensAt) <= now;
  const full = occurrence.capacity !== null && occurrence.going >= occurrence.capacity;
  const records = view?.link?.status === 'active' ? view.records : [];
  const bookedFor = new Set(
    records
      .filter((r) => r.bookings.some((b) => b.occurrenceId === occurrence.occurrenceId))
      .map((r) => r.memberId),
  );
  // `numeric`, matching formatDateTime's start («5:30–6:30», not «5:30–06:30»).
  const endTime = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Europe/Sofia',
  }).format(new Date(occurrence.endsAt));
  const pill =
    'inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink hover:bg-surface-2 focus-visible:shadow-[var(--ring)] focus-visible:outline-none';

  let action: ReactNode = null;
  if (occurrence.cancelled) {
    action = <p className="text-body-sm text-danger">{t('class.cancelled')}</p>;
  } else if (started) {
    action = <p className="text-body-sm text-text-muted">{t('class.started')}</p>;
  } else if (!user) {
    action = (
      <Link
        href={signInHref(`/klub/${slug}/trenirovka/${occurrence.occurrenceId}`)}
        className="font-semibold text-link hover:text-link-hover"
      >
        {t('class.signIn')}
      </Link>
    );
  } else if (records.length > 0) {
    const bookable = records.filter((r) => !bookedFor.has(r.memberId));
    action = (
      <div className="space-y-2">
        {bookedFor.size > 0 && <Badge tone="success">{t('class.booked')}</Badge>}
        {!open ? (
          <p className="text-caption text-text-muted">
            {t('class.opensAt', { time: formatDateTime(occurrence.bookingOpensAt, locale) })}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {bookable.map((record) => (
              <form key={record.memberId} action={portalOpAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="memberId" value={record.memberId} />
                <input type="hidden" name="op" value="book" />
                <input type="hidden" name="occurrenceId" value={occurrence.occurrenceId} />
                <button type="submit" className={pill}>
                  {full
                    ? t('class.joinWaitlist')
                    : record.self
                      ? t('class.book')
                      : `${t('class.book')} · ${record.displayName}`}
                </button>
              </form>
            ))}
          </div>
        )}
      </div>
    );
  } else if (occurrence.trialAllowed) {
    action = (
      <form action={trialAction} className="space-y-2">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="occurrenceId" value={occurrence.occurrenceId} />
        <p className="text-caption text-text-muted">{t('class.trialNote')}</p>
        <Button type="submit">{t('class.bookTrial')}</Button>
      </form>
    );
  }

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-md space-y-4 p-4">
        <Link
          href={`/klub/${slug}`}
          className="text-body-sm font-semibold text-link hover:text-link-hover"
        >
          ← {occurrence.clubName}
        </Link>
        <header className="space-y-1">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{occurrence.title}</h1>
          <p className="flex flex-wrap gap-1.5">
            <Badge tone="brand">{sportLabel(occurrence.sport)}</Badge>
            {occurrence.trialAllowed && <Badge tone="info">{t('trial')}</Badge>}
          </p>
        </header>

        <div role="status" aria-live="polite">
          {rezultat && t.has(`class.outcome.${rezultat}`) && (
            <p
              className={cn(
                'rounded-card border p-3 text-body-sm text-ink',
                GOOD.has(rezultat)
                  ? 'border-success-border bg-success-bg'
                  : 'border-warning-border bg-warning-bg',
              )}
            >
              {t(`class.outcome.${rezultat}`)}
            </p>
          )}
        </div>

        <dl className="space-y-2 rounded-card border border-line bg-surface p-4 text-body-sm shadow-sm">
          <div>
            <dt className="text-caption text-text-muted">{t('class.when')}</dt>
            <dd className="text-ink">
              {formatDateTime(occurrence.startsAt, locale)}–{endTime}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('class.where')}</dt>
            <dd className="text-ink">
              {occurrence.facilitySlug ? (
                <Link href={`/obekt/${occurrence.facilitySlug}`} className="text-link">
                  {occurrence.locationName}
                </Link>
              ) : (
                occurrence.locationName
              )}
            </dd>
          </div>
          {occurrence.instructorName && (
            <div>
              <dt className="text-caption text-text-muted">{t('class.trainer')}</dt>
              <dd className="text-ink">{occurrence.instructorName}</dd>
            </div>
          )}
          <div>
            <dt className="text-caption text-text-muted">{t('class.spots')}</dt>
            <dd className="text-ink">
              {full
                ? t('full')
                : occurrence.capacity === null
                  ? t('spotsOpen', { going: occurrence.going })
                  : t('spots', { going: occurrence.going, capacity: occurrence.capacity })}
            </dd>
          </div>
        </dl>

        {occurrence.description && (
          <p className="whitespace-pre-line text-body-sm text-ink-soft">{occurrence.description}</p>
        )}

        {action}
      </main>
    </AppShell>
  );
}
