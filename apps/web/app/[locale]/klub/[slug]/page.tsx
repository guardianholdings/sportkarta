import { advertisedPrice, formatEuro, sofiaToday } from '@sportkarta/lib/clubs';
import { ExternalLink, MapPin } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { clubsEnabled } from '@/lib/clubs/access';
import { publicEvents } from '@/lib/clubs/events';
import { publicRating } from '@/lib/clubs/feedback';
import { clubTakesInquiries } from '@/lib/clubs/inbox';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { MIN_ONLINE_CENTS, clubTakesPayments } from '@/lib/clubs/payments';
import { publicOffers } from '@/lib/clubs/promotions';
import { publicServices } from '@/lib/clubs/reservations';
import { publicClub } from '@/lib/clubs/public';
import { formatDate, formatDateTime } from '@/lib/format';
import { buildAlternates } from '@/lib/seo';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!clubsEnabled()) return {};
  const club = await publicClub(slug, locale);
  if (!club) return { robots: { index: false, follow: false } };
  const [t, label] = await Promise.all([
    getTranslations({ locale, namespace: 'ClubPublic' }),
    clubSportLabeler(),
  ]);
  return {
    title: t('metaTitle', {
      name: club.name,
      sports: club.sports.slice(0, 3).map(label).join(', '),
    }),
    description: t('metaDescription', { name: club.name }),
    alternates: buildAlternates(`/klub/${club.slug}`, locale),
    // The club's own installable app (0051).
    manifest: `/klub/${club.slug}/manifest.webmanifest`,
  };
}

/**
 * A club's public page. RENDERABLE clubs only (public.ts) — a hidden, lapsed
 * or suspended club 404s here exactly as it vanishes from /klubove and from
 * facility pages. A paid club's own website link is `sponsored`: it is a
 * commercial listing on a platform whose links are otherwise editorial.
 */
export default async function PublicClubPage({ params }: { params: PageParams }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  if (!clubsEnabled()) notFound();
  const club = await publicClub(slug, locale);
  if (!club) notFound();
  const [
    t,
    tClub,
    sportLabel,
    takesPayments,
    services,
    offers,
    rating,
    inquiries,
    events,
    tEvents,
  ] = await Promise.all([
    getTranslations('ClubPublic'),
    getTranslations('Club'),
    clubSportLabeler(),
    clubTakesPayments(club.id),
    publicServices(club.id, locale),
    publicOffers(club.id, sofiaToday()),
    publicRating(club.id),
    clubTakesInquiries(club.id),
    publicEvents(club.id, locale, 12),
    getTranslations('ClubEvents'),
  ]);
  const today = sofiaToday();
  // An automatic offer open to a new visitor, struck through (0049). Not on a
  // subscription, which renews at the price it was opened with.
  const deal = (plan: (typeof club.plans)[number]) =>
    plan.kind === 'trial' || (plan.autoRenew && plan.validityMonths !== null)
      ? null
      : advertisedPrice(
          offers,
          { kind: 'plan', id: plan.id, unitPriceCents: plan.priceCents, quantity: 1 },
          today,
        );
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const trialClasses = club.classes.filter((c) => c.trialAllowed);
  const paid = club.tier !== 'community';
  // The club's accent (0045): one of the design system's scales, never a value
  // the club typed — a band over the header, nothing that carries meaning.
  const accentBand = {
    green: 'border-green-500',
    coral: 'border-coral-500',
    sky: 'border-sky-500',
  }[club.accent];

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-3xl space-y-5 p-4">
        <header
          className={`flex flex-wrap items-start gap-4 rounded-card border-t-4 border-b border-b-line pb-4 pt-4 ${accentBand}`}
        >
          {club.hasLogo && (
            // eslint-disable-next-line @next/next/no-img-element -- the row-decides logo route
            <img
              src={`/api/clubs/logo/${club.id}`}
              alt=""
              width={72}
              height={72}
              className="size-18 shrink-0 rounded-card object-contain"
            />
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="text-h2 font-extrabold tracking-tight text-ink">{club.name}</h1>
            <p className="flex flex-wrap gap-1.5">
              <Badge tone="neutral">{tClub(`kind.${club.kind}`)}</Badge>
              {club.sports.map((sport) => (
                <Badge key={sport} tone="brand">
                  {sportLabel(sport)}
                </Badge>
              ))}
            </p>
            {rating && (
              // An average only, from enough ratings that no single one shows (0052).
              <p className="text-body-sm text-ink-soft">
                <span aria-hidden="true">★ </span>
                {t('rating', {
                  average: new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  }).format(rating.average),
                  count: rating.count,
                })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {trialClasses.length > 0 && (
                <Link
                  href={`/klub/${club.slug}/trenirovka/${trialClasses[0]?.occurrenceId ?? ''}`}
                  className={buttonVariants({ variant: 'accent' })}
                >
                  {t('trial')}
                </Link>
              )}
              <Link
                href={`/klub/${club.slug}/az`}
                className={buttonVariants({ variant: 'secondary' })}
              >
                {t('memberHere')} {t('myClub')}
              </Link>
              {inquiries && (
                <Link
                  href={`/klub/${club.slug}/zapitvane`}
                  className={buttonVariants({ variant: 'secondary' })}
                >
                  {t('inquiry')}
                </Link>
              )}
            </div>
          </div>
        </header>

        {club.description && (
          <section className={section}>
            <h2 className="text-h4 font-bold text-ink">{t('about')}</h2>
            <p className="whitespace-pre-line text-body-sm text-ink">{club.description}</p>
          </section>
        )}

        <section className={section} aria-labelledby="classes-h">
          <h2 id="classes-h" className="text-h4 font-bold text-ink">
            {t('classesTitle')}
          </h2>
          {club.classes.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('noClasses')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {club.classes.map((cls) => {
                const full = cls.capacity !== null && cls.going >= cls.capacity;
                return (
                  <li key={cls.occurrenceId}>
                    <Link
                      href={`/klub/${club.slug}/trenirovka/${cls.occurrenceId}`}
                      className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2 text-body-sm focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                    >
                      <span>
                        <span className="font-medium text-link">{cls.title}</span>
                        <span className="block text-caption text-text-muted">
                          {formatDateTime(cls.startsAt, locale)} · {sportLabel(cls.sport)} ·{' '}
                          {cls.locationName}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {cls.trialAllowed && <Badge tone="info">{t('trial')}</Badge>}
                        <span className="text-caption text-ink-soft">
                          {full
                            ? t('full')
                            : cls.capacity === null
                              ? t('spotsOpen', { going: cls.going })
                              : t('spots', { going: cls.going, capacity: cls.capacity })}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section id="ceni" className={section} aria-labelledby="plans-h">
          <h2 id="plans-h" className="text-h4 font-bold text-ink">
            {t('plansTitle')}
          </h2>
          {club.plans.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('noPlans')}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {club.plans.map((plan) => (
                <li key={plan.id} className="rounded-card border border-line p-3">
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-ink">{plan.name}</span>
                    <span className="font-mono tabular-nums text-ink">
                      {deal(plan) ? (
                        <>
                          <s className="text-text-muted">{formatEuro(plan.priceCents, locale)}</s>{' '}
                          {formatEuro(deal(plan)?.priceCents ?? plan.priceCents, locale)}
                        </>
                      ) : (
                        formatEuro(plan.priceCents, locale)
                      )}
                    </span>
                  </p>
                  {deal(plan) && (
                    <p className="text-caption font-semibold text-ink-soft">
                      {deal(plan)?.promotion.name}
                      {deal(plan)?.promotion.newMembersOnly ? ` · ${t('offerNewOnly')}` : ''}
                      {deal(plan)?.promotion.endsOn
                        ? ` · ${t('offerUntil', { date: formatDate(deal(plan)?.promotion.endsOn ?? today, locale) })}`
                        : ''}
                    </p>
                  )}
                  <p className="text-caption text-text-muted">
                    {plan.validityMonths
                      ? t('validityMonths', { count: plan.validityMonths })
                      : t('validityDays', { count: plan.validityDays ?? 1 })}
                    {plan.visitsCount ? ` · ${t('visits', { count: plan.visitsCount })}` : ''}
                    {plan.audience !== 'all' ? ` · ${tClub(`audience.${plan.audience}`)}` : ''}
                  </p>
                  {plan.description && (
                    <p className="mt-1 text-caption text-ink-soft">{plan.description}</p>
                  )}
                  {takesPayments &&
                    plan.kind !== 'trial' &&
                    plan.priceCents >= MIN_ONLINE_CENTS && (
                      <Link
                        href={`/klub/${club.slug}/kupi/${plan.id}`}
                        className={cn(buttonVariants({ size: 'sm' }), 'mt-2')}
                      >
                        {t('buyOnline')}
                      </Link>
                    )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {services.length > 0 && (
          <section id="rezervatsii" className={section} aria-labelledby="services-h">
            <h2 id="services-h" className="text-h4 font-bold text-ink">
              {t('servicesTitle')}
            </h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {services.map((service) => (
                <li key={service.id} className="rounded-card border border-line p-3">
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-ink">{service.name}</span>
                    <span className="font-mono tabular-nums text-ink">
                      {formatEuro(service.priceCents, locale)}
                    </span>
                  </p>
                  <p className="text-caption text-text-muted">
                    {service.priceUnit === 'hour' ? t('perHour') : t('perBooking')}
                    {service.memberPriceCents !== null
                      ? ` · ${t('memberPrice', { amount: formatEuro(service.memberPriceCents, locale) })}`
                      : ''}
                  </p>
                  {service.description && (
                    <p className="mt-1 text-caption text-ink-soft">{service.description}</p>
                  )}
                  <Link
                    href={{
                      pathname: `/klub/${club.slug}/rezervatsiya`,
                      query: { usluga: service.id },
                    }}
                    className={cn(buttonVariants({ size: 'sm', variant: 'secondary' }), 'mt-2')}
                  >
                    {t('reserve')}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {events.length > 0 && (
          <section id="sabitiya" className={section} aria-labelledby="events-h">
            <h2 id="events-h" className="text-h4 font-bold text-ink">
              {t('eventsTitle')}
            </h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {events.map((event) => (
                <li key={event.id} className="rounded-card border border-line p-3">
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-ink">{event.title}</span>
                    {event.fromCents !== null && (
                      <span className="font-mono tabular-nums text-ink">
                        {event.fromCents === 0
                          ? tEvents('public.free')
                          : formatEuro(event.fromCents, locale)}
                      </span>
                    )}
                  </p>
                  <p className="text-caption text-text-muted">
                    {tEvents(`kinds.${event.kind}`)} · {formatDateTime(event.startsAt, locale)}
                  </p>
                  <Link
                    href={`/klub/${club.slug}/sabitie/${event.id}`}
                    className={cn(buttonVariants({ size: 'sm', variant: 'secondary' }), 'mt-2')}
                  >
                    {tEvents('public.more')}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {club.trainers.length > 0 && (
          <section className={section} aria-labelledby="trainers-h">
            <h2 id="trainers-h" className="text-h4 font-bold text-ink">
              {t('trainersTitle')}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {club.trainers.map((trainer) => (
                <li key={trainer.name} className="rounded-card border border-line p-3">
                  <p className="font-semibold text-ink">{trainer.name}</p>
                  {trainer.bio && (
                    <p className="mt-1 whitespace-pre-line text-caption text-ink-soft">
                      {trainer.bio}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {club.faq.length > 0 && (
          <section className={section} aria-labelledby="faq-h">
            <h2 id="faq-h" className="text-h4 font-bold text-ink">
              {t('faqTitle')}
            </h2>
            <div className="divide-y divide-line">
              {club.faq.map((entry, index) => (
                <details key={index} className="group py-2">
                  <summary className="flex min-h-11 cursor-pointer items-center text-body-sm font-semibold text-ink">
                    {entry.question}
                  </summary>
                  <p className="whitespace-pre-line pb-2 text-body-sm text-ink-soft">
                    {entry.answer}
                  </p>
                </details>
              ))}
            </div>
          </section>
        )}

        {club.locations.length > 0 && (
          <section className={section} aria-labelledby="where-h">
            <h2 id="where-h" className="text-h4 font-bold text-ink">
              {t('where')}
            </h2>
            <ul className="space-y-2">
              {club.locations.map((location) => (
                <li key={location.id} className="flex gap-2 text-body-sm">
                  <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-soft" />
                  <span>
                    <span className="font-medium text-ink">{location.name}</span>
                    {location.address && (
                      <span className="block text-caption text-text-muted">{location.address}</span>
                    )}
                    {location.facilitySlug && (
                      <Link
                        href={`/obekt/${location.facilitySlug}`}
                        className="block text-caption font-semibold text-link"
                      >
                        {location.facilityName} · {t('onMap')}
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(club.websiteUrl || club.publicEmail || club.publicPhone) && (
          <section className={section} aria-labelledby="contact-h">
            <h2 id="contact-h" className="text-h4 font-bold text-ink">
              {t('contact')}
            </h2>
            <ul className="space-y-1 text-body-sm">
              {club.websiteUrl && (
                <li>
                  <a
                    href={club.websiteUrl}
                    target="_blank"
                    rel={paid ? 'sponsored noopener' : 'noopener'}
                    className="inline-flex items-center gap-1 font-semibold text-link"
                  >
                    {t('website')}
                    <ExternalLink aria-hidden="true" className="size-4" />
                  </a>
                </li>
              )}
              {club.publicEmail && (
                <li>
                  <a href={`mailto:${club.publicEmail}`} className="text-link">
                    {club.publicEmail}
                  </a>
                </li>
              )}
              {club.publicPhone && (
                <li>
                  <a href={`tel:${club.publicPhone}`} className="text-link">
                    {club.publicPhone}
                  </a>
                </li>
              )}
            </ul>
          </section>
        )}
      </main>
    </AppShell>
  );
}
