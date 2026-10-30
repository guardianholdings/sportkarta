import { EVENT_TEAM_NAME_MAX, formatEuro } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { memberEventPlaces, publicEvent } from '@/lib/clubs/events';
import { isUuid } from '@/lib/clubs/input';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { clubTakesPayments } from '@/lib/clubs/payments';
import { portalView } from '@/lib/clubs/portal';
import { publicClub } from '@/lib/clubs/public';
import { formatDateTime } from '@/lib/format';
import { signInHref } from '@/lib/sign-in-destination';
import { cn } from '@/lib/utils';

import { cancelPlaceAction, payPlaceAction, registerAction } from './actions';

export const dynamic = 'force-dynamic';

const GOOD = new Set([
  'registered',
  'registered_waitlist',
  'place_cancelled',
  'place_cancelled_late',
]);

type PageParams = Promise<{ locale: string; slug: string; eventId: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, slug, eventId } = await params;
  if (!clubsEnabled() || !isUuid(eventId)) return {};
  const club = await publicClub(slug, locale);
  const event = club ? await publicEvent(club.id, eventId, locale) : null;
  return {
    title: event && club ? `${event.title} — ${club.name}` : undefined,
    robots: { index: event?.status === 'published', follow: true },
  };
}

/**
 * One event, publicly (0053): what, when, where, the tickets with what each
 * costs and how many seats are left — counts, never names — and the action
 * that fits the viewer: register (for themselves or a child), join the line
 * when it is full, pay a held place, give a place up, or sign in first.
 */
export default async function PublicEventPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, eventId } = await params;
  setRequestLocale(locale);
  if (!clubsEnabled() || !isUuid(eventId)) notFound();
  const club = await publicClub(slug, locale);
  if (!club) notFound();
  const user = await getCurrentUser();
  // A place at an event the club keeps off its page (the desk registered it)
  // still opens the event for its holder — to see it, pay, or give it up.
  const mine = user ? await memberEventPlaces(user.id, club.id, locale, eventId) : [];
  const event = await publicEvent(club.id, eventId, locale, { viewerHasPlace: mine.length > 0 });
  if (!event) notFound();
  const { rezultat } = await searchParams;
  const [t, tClub, sportLabel, view, online] = await Promise.all([
    getTranslations('ClubEvents'),
    getTranslations('Club'),
    clubSportLabeler(),
    user ? portalView(user.id, slug, locale) : Promise.resolve(null),
    clubTakesPayments(club.id),
  ]);
  const records = view?.link?.status === 'active' ? view.records : [];
  const selfMissing = !records.some((r) => r.self);
  const placed = new Set(mine.map((p) => p.memberId));
  const forWhom = records.filter((r) => !placed.has(r.memberId));
  const canSelf = selfMissing && !mine.some((p) => p.memberId === view?.link?.memberId);
  const pill =
    'inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink hover:bg-surface-2 focus-visible:shadow-[var(--ring)] focus-visible:outline-none';
  const outcome = rezultat
    ? t.has(`public.outcome.${rezultat}`)
      ? t(`public.outcome.${rezultat}`)
      : t('public.outcome.generic')
    : null;

  let action: ReactNode = null;
  if (event.status === 'cancelled') {
    action = <p className="text-body-sm text-danger">{t('public.cancelled')}</p>;
  } else if (!event.open) {
    action = <p className="text-body-sm text-text-muted">{t('public.closed')}</p>;
  } else if (!user) {
    action = (
      <Link
        href={signInHref(`/klub/${slug}/sabitie/${event.id}`)}
        className="font-semibold text-link hover:text-link-hover"
      >
        {t('public.signIn')}
      </Link>
    );
  } else if (view?.link?.status === 'pending') {
    action = <p className="text-body-sm text-text-muted">{t('public.outcome.link_pending')}</p>;
  } else if (event.tickets.length > 0 && (forWhom.length > 0 || canSelf)) {
    action = (
      <form action={registerAction} className="space-y-3">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="eventId" value={event.id} />
        <input type="hidden" name="teamEvent" value={event.teamEvent ? '1' : '0'} />
        <fieldset className="space-y-1">
          <legend className="text-body-sm font-semibold text-ink">{t('public.ticket')}</legend>
          {event.tickets.map((ticket, i) => (
            <label
              key={ticket.id}
              className="flex min-h-11 items-center gap-2 text-body-sm text-ink"
            >
              <input
                type="radio"
                name="ticketId"
                value={ticket.id}
                defaultChecked={i === 0}
                className="size-4 accent-[var(--brand)]"
              />
              <span className="min-w-0 flex-1">
                {ticket.name}
                {ticket.audience !== 'all' && (
                  <span className="text-caption text-text-muted">
                    {' '}
                    · {tClub(`audience.${ticket.audience}`)}
                  </span>
                )}
              </span>
              <span className="text-caption text-text-muted">
                {ticket.priceCents === 0 ? t('public.free') : formatEuro(ticket.priceCents, locale)}
                {ticket.memberPriceCents !== null &&
                  ` · ${t('tickets.memberPriceShort', { amount: formatEuro(ticket.memberPriceCents, locale) })}`}
                {' · '}
                {ticket.seatsLeft === null
                  ? t('public.seatsOpen')
                  : ticket.seatsLeft === 0
                    ? t('public.lineOnly')
                    : t('public.seatsLeft', { count: ticket.seatsLeft })}
              </span>
            </label>
          ))}
        </fieldset>
        {(forWhom.length > 1 || (forWhom.length > 0 && canSelf)) && (
          <label className="block text-body-sm font-semibold text-ink">
            {t('public.forWhom')}
            <Select name="memberId" className="mt-1">
              {canSelf && <option value="">{t('public.forMe')}</option>}
              {forWhom.map((r) => (
                <option key={r.memberId} value={r.memberId}>
                  {r.self ? t('public.forMe') : r.displayName}
                </option>
              ))}
            </Select>
          </label>
        )}
        {forWhom.length === 1 && !canSelf && (
          <p className="text-body-sm text-ink">
            <input type="hidden" name="memberId" value={forWhom[0]?.memberId} />
            {t('public.forName', {
              name: forWhom[0]?.self ? t('public.forMe') : (forWhom[0]?.displayName ?? ''),
            })}
          </p>
        )}
        {event.teamEvent && (
          <label className="block text-body-sm font-semibold text-ink">
            {t('public.team')}
            <Input name="teamName" required maxLength={EVENT_TEAM_NAME_MAX} className="mt-1" />
          </label>
        )}
        <p className="text-caption text-text-muted">
          {event.payment === 'online_required'
            ? online
              ? t('public.payOnlineNow')
              : t('public.payUnavailable')
            : event.payment === 'online_optional'
              ? t('public.payOnlineLater')
              : t('public.payAtDesk')}
        </p>
        <Button type="submit">
          {event.tickets.every((ticket) => ticket.seatsLeft === 0)
            ? t('public.joinLine')
            : t('public.register')}
        </Button>
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
          ← {club.name}
        </Link>
        <header className="space-y-1">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{event.title}</h1>
          <p className="flex flex-wrap gap-1.5">
            <Badge tone="brand">{t(`kinds.${event.kind}`)}</Badge>
            {event.sport && <Badge tone="neutral">{sportLabel(event.sport)}</Badge>}
          </p>
        </header>

        <div role="status" aria-live="polite">
          {outcome && (
            <p
              className={cn(
                'rounded-card border p-3 text-body-sm text-ink',
                rezultat && GOOD.has(rezultat)
                  ? 'border-success-border bg-success-bg'
                  : 'border-warning-border bg-warning-bg',
              )}
            >
              {outcome}
            </p>
          )}
        </div>

        <dl className="space-y-2 rounded-card border border-line bg-surface p-4 text-body-sm shadow-sm">
          <div>
            <dt className="text-caption text-text-muted">{t('public.when')}</dt>
            <dd className="text-ink">
              {formatDateTime(event.startsAt, locale)} – {formatDateTime(event.endsAt, locale)}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('public.where')}</dt>
            <dd className="text-ink">
              {[event.locationName, event.resourceName].filter(Boolean).join(' · ')}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('public.seatsTitle')}</dt>
            <dd className="text-ink">
              {event.capacity === null
                ? t('seatsOpen', { taken: event.taken })
                : t('seats', { taken: event.taken, capacity: event.capacity })}
              {event.waitlisted > 0 && ` · ${t('waitlisted', { count: event.waitlisted })}`}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('public.terms')}</dt>
            <dd className="text-ink">
              {t('public.cancelHours', { hours: event.cancelDeadlineHours })}
              {event.registrationClosesAt &&
                ` · ${t('public.closes', { when: formatDateTime(event.registrationClosesAt, locale) })}`}
            </dd>
          </div>
        </dl>

        {event.description && (
          <p className="whitespace-pre-line text-body-sm text-ink-soft">{event.description}</p>
        )}

        {mine.length > 0 && (
          <section
            className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm"
            aria-labelledby="mine-h"
          >
            <h2 id="mine-h" className="text-h4 font-bold text-ink">
              {t('public.mine')}
            </h2>
            <ul className="divide-y divide-line">
              {mine.map((place) => (
                <li key={place.id} className="space-y-2 py-2 text-body-sm">
                  <p className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-ink">
                      {place.memberName} · {place.ticketName}
                    </span>
                    <Badge
                      tone={
                        place.state === 'confirmed'
                          ? 'success'
                          : place.state === 'held'
                            ? 'warning'
                            : 'info'
                      }
                    >
                      {place.position !== null
                        ? t('places.position', { position: place.position })
                        : t(`places.state.${place.state}`)}
                    </Badge>
                  </p>
                  {place.state === 'held' && place.holdExpiresAt && (
                    <p className="text-caption text-text-muted">
                      {t('public.payBy', { when: formatDateTime(place.holdExpiresAt, locale) })}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {place.owedCents > 0 && place.chargeId && online && (
                      <form action={payPlaceAction}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="eventId" value={event.id} />
                        <input type="hidden" name="chargeId" value={place.chargeId} />
                        <button type="submit" className={pill}>
                          {t('public.pay', { amount: formatEuro(place.owedCents, locale) })}
                        </button>
                      </form>
                    )}
                    <form action={cancelPlaceAction}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="eventId" value={event.id} />
                      <input type="hidden" name="registrationId" value={place.id} />
                      <ConfirmButton
                        message={
                          place.state === 'confirmed' &&
                          Date.parse(place.freeCancelUntil) < Date.now()
                            ? t('public.cancelLateConfirm')
                            : t('public.cancelConfirm')
                        }
                        className={pill}
                      >
                        {t('public.cancel')}
                      </ConfirmButton>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {action && (
          <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
            {action}
          </section>
        )}

        <p className="text-caption text-text-muted">
          <a
            href={`/kalendar/klub-sabitie/${event.id}.ics`}
            className="font-semibold text-link hover:text-link-hover"
          >
            {t('public.ics')}
          </a>
        </p>
      </main>
    </AppShell>
  );
}
