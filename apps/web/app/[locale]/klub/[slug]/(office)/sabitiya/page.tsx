import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { chipClass } from '@/components/ui/chip';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { EVENT_FILTERS, listEvents, type EventFilter } from '@/lib/clubs/events';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * «Събития» (0053, wave D1): the club's events, camps, workshops and
 * tournaments — upcoming, drafts, past, cancelled — with seats taken and the
 * line. Everybody on the staff sees them; management puts them on.
 */
export default async function ClubEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ f?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'schedule.view');
  const { f } = await searchParams;
  const filter: EventFilter = (EVENT_FILTERS as readonly string[]).includes(f ?? '')
    ? (f as EventFilter)
    : 'upcoming';
  const [t, events] = await Promise.all([
    getTranslations('ClubEvents'),
    listEvents(actor, filter, locale),
  ]);
  const base = `/klub/${slug}/sabitiya`;

  return (
    <main className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
        </div>
        {actorCan(actor, 'events.manage') && (
          <Link href={`${base}/novo`} className={buttonVariants({ variant: 'accent' })}>
            {t('new')}
          </Link>
        )}
      </div>

      <nav aria-label={t('title')} className="-mx-4 overflow-x-auto px-4">
        <ul className="flex gap-2 pb-1">
          {EVENT_FILTERS.map((value) => (
            <li key={value}>
              <Link
                href={{ pathname: base, query: value === 'upcoming' ? {} : { f: value } }}
                aria-current={value === filter ? 'page' : undefined}
                className={chipClass({ selected: value === filter, className: 'min-h-11' })}
              >
                {t(`filters.${value}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        {events.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((event) => (
              <li key={event.id} className="py-2.5">
                <Link
                  href={`${base}/${event.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body-sm font-semibold text-ink">{event.title}</span>
                    <span className="block text-caption text-text-muted">
                      {t(`kinds.${event.kind}`)} · {event.locationName} ·{' '}
                      <time dateTime={event.startsAt}>
                        {formatDateTime(event.startsAt, locale)}
                      </time>
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
                    {event.status === 'draft' && <Badge tone="neutral">{t('draft')}</Badge>}
                    {event.status === 'cancelled' && <Badge tone="neutral">{t('cancelled')}</Badge>}
                    <span>
                      {event.capacity === null
                        ? t('seatsOpen', { taken: event.taken })
                        : t('seats', { taken: event.taken, capacity: event.capacity })}
                    </span>
                    {event.waitlisted > 0 && (
                      <Badge tone="brand">{t('waitlisted', { count: event.waitlisted })}</Badge>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
