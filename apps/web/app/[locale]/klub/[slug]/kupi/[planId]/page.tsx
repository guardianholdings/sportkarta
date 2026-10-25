import { addDaysIso, formatEuro, sofiaToday } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Link, redirect } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { isUuid } from '@/lib/clubs/input';
import { clubTakesPayments } from '@/lib/clubs/payments';
import { portalView } from '@/lib/clubs/portal';
import { buyerOfferPrices, clubTakesOffers, type OfferPrice } from '@/lib/clubs/promotions';
import { publicClub } from '@/lib/clubs/public';
import { signInHref } from '@/lib/sign-in-destination';

import { buyPlanAction } from './actions';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string; planId: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubPurchase' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * Buy a public plan online. Everything a buyer must know before paying is on
 * this page, in words: the price, what it covers, whether it renews and how
 * to stop it, the club's own terms, and that the club — not POPS — is the
 * seller. The card itself is entered on Stripe's page.
 */
export default async function BuyPlanPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, planId } = await params;
  setRequestLocale(locale);
  if (!clubsEnabled() || !isUuid(planId)) notFound();
  const club = await publicClub(slug, locale);
  const plan = club?.plans.find((p) => p.id === planId && p.kind !== 'trial');
  if (!club || !plan) notFound();
  const user = await getCurrentUser();
  if (!user) return redirect({ href: signInHref(`/klub/${slug}/kupi/${planId}`), locale });
  const [t, tPublic, tClub, takesPayments, view, offersOn] = await Promise.all([
    getTranslations('ClubPurchase'),
    getTranslations('ClubPublic'),
    getTranslations('Club'),
    clubTakesPayments(club.id),
    portalView(user.id, slug, locale),
    clubTakesOffers(club.id),
  ]);
  // Offers (0049) apply to a one-off purchase only: a subscription renews at
  // the price it was opened with, so a discount there would repeat.
  const subscription = plan.autoRenew && plan.validityMonths !== null;
  const { rezultat } = await searchParams;
  const termsUrl = view?.club.termsUrl ?? null;
  // Who it can be for: the account's own record and its children, where the
  // plan's audience fits. With no record yet, «for me» creates one on payment.
  const records = view?.link?.status === 'active' ? view.records : [];
  const fits = (isMinor: boolean) =>
    plan.audience === 'all' || (plan.audience === 'minors') === isMinor;
  const choices = records.filter((r) => fits(r.isMinor));
  const selfMissing = !records.some((r) => r.self) && fits(false);
  const today = sofiaToday();
  // The price each record would be charged (null: none applies), by the
  // purchase's own rules; '' is «for me» with no record yet — a new client.
  const prices =
    subscription || !offersOn
      ? null
      : await buyerOfferPrices(
          club.id,
          { kind: 'plan', id: plan.id, unitPriceCents: plan.priceCents, quantity: 1 },
          choices.map((r) => r.memberId),
          today,
        );
  const priceFor = (memberId: string): OfferPrice | null =>
    prices === null
      ? null
      : memberId === ''
        ? prices.newClient
        : (prices.byMember[memberId] ?? null);
  const options = [...(selfMissing ? [''] : []), ...choices.map((r) => r.memberId)];
  const offer = priceFor(options[0] ?? '');
  // With more than one record to choose from, each shows its own price.
  const pricePerOption = options.length > 1 && options.some((id) => priceFor(id) !== null);
  const optionPrice = (memberId: string) => {
    const own = priceFor(memberId);
    return (
      <span className="ml-auto font-mono tabular-nums">
        {own ? (
          <>
            <s className="text-text-muted">{formatEuro(plan.priceCents, locale)}</s>{' '}
            {formatEuro(own.priceCents, locale)}
          </>
        ) : (
          formatEuro(plan.priceCents, locale)
        )}
      </span>
    );
  };
  const validity = plan.validityMonths
    ? tPublic('validityMonths', { count: plan.validityMonths })
    : tPublic('validityDays', { count: plan.validityDays ?? 1 });

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-md space-y-4 p-4">
        <Link
          href={`/klub/${slug}#ceni`}
          className="text-body-sm font-semibold text-link hover:text-link-hover"
        >
          ← {club.name}
        </Link>
        <header className="space-y-1">
          <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
            {t('title')}
          </p>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{plan.name}</h1>
          <p className="font-mono text-h4 tabular-nums text-ink">
            {offer ? (
              <>
                <s className="text-text-muted">{formatEuro(plan.priceCents, locale)}</s>{' '}
                {formatEuro(offer.priceCents, locale)}
              </>
            ) : (
              formatEuro(plan.priceCents, locale)
            )}
          </p>
          {offer && <p className="text-caption text-ink-soft">{offer.promotion.name}</p>}
        </header>

        <div role="status" aria-live="polite">
          {rezultat && t.has(`error.${rezultat}`) && (
            <p className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink">
              {t(`error.${rezultat}`)}
            </p>
          )}
        </div>

        <dl className="space-y-2 rounded-card border border-line bg-surface p-4 text-body-sm shadow-sm">
          <div>
            <dt className="text-caption text-text-muted">{t('covers')}</dt>
            <dd className="text-ink">
              {validity}
              {plan.visitsCount ? ` · ${tPublic('visits', { count: plan.visitsCount })}` : ''}
              {plan.audience !== 'all' ? ` · ${tClub(`audience.${plan.audience}`)}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('renewal')}</dt>
            <dd className="text-ink">
              {plan.autoRenew && plan.validityMonths
                ? t('renewsMonthly', { months: plan.validityMonths })
                : t('oneOff')}
              {plan.autoRenew && plan.noticeDays > 0
                ? ` ${t('notice', { days: plan.noticeDays })}`
                : ''}
              {plan.autoRenew && plan.minTermMonths
                ? ` ${t('minTerm', { months: plan.minTermMonths })}`
                : ''}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('seller')}</dt>
            <dd className="text-ink">{t('sellerIs', { club: club.name })}</dd>
          </div>
        </dl>
        {plan.description && (
          <p className="whitespace-pre-line text-body-sm text-ink-soft">{plan.description}</p>
        )}

        {!takesPayments ? (
          <p className="text-body-sm text-text-muted">{t('unavailable')}</p>
        ) : view?.link?.status === 'pending' ? (
          <p className="text-body-sm text-text-muted">{t('error.link_pending')}</p>
        ) : choices.length === 0 && !selfMissing ? (
          <p className="text-body-sm text-text-muted">{t('error.audience_mismatch')}</p>
        ) : (
          <form
            action={buyPlanAction}
            className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm"
          >
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="planId" value={plan.id} />
            <fieldset className="space-y-1">
              <legend className="text-body-sm font-semibold text-ink">{t('forWhom')}</legend>
              {selfMissing && (
                <label className="flex min-h-11 items-center gap-2 text-body-sm text-ink">
                  <input
                    type="radio"
                    name="memberId"
                    value=""
                    defaultChecked
                    className="size-4 accent-[var(--brand)]"
                  />
                  {t('forMe')}
                  {pricePerOption && optionPrice('')}
                </label>
              )}
              {choices.map((record, index) => (
                <label
                  key={record.memberId}
                  className="flex min-h-11 items-center gap-2 text-body-sm text-ink"
                >
                  <input
                    type="radio"
                    name="memberId"
                    value={record.memberId}
                    defaultChecked={!selfMissing && index === 0}
                    className="size-4 accent-[var(--brand)]"
                  />
                  {record.self ? t('forMe') : record.displayName}
                  {pricePerOption && optionPrice(record.memberId)}
                </label>
              ))}
            </fieldset>
            <label className="block text-body-sm font-semibold text-ink">
              {t('startsOn')}
              <input
                type="date"
                name="startsOn"
                min={today}
                max={addDaysIso(today, 60)}
                className="mt-1 block min-h-11 rounded-input border border-line-strong bg-surface px-3 text-body-sm text-ink focus-visible:border-brand"
              />
              <span className="mt-1 block text-caption font-normal text-text-muted">
                {t('startsOnHint')}
              </span>
            </label>
            {termsUrl && (
              <>
                <label className="flex items-start gap-2 text-body-sm text-ink">
                  <input
                    type="checkbox"
                    name="terms"
                    value="1"
                    required
                    className="mt-1 size-4 accent-[var(--brand)]"
                  />
                  <span>
                    {t('termsAccept')}{' '}
                    <a
                      href={termsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-link hover:text-link-hover"
                    >
                      {t('termsLink')}
                    </a>
                  </span>
                </label>
              </>
            )}
            {offersOn && !subscription && (
              <label className="block text-body-sm font-semibold text-ink">
                {t('code')}
                <input
                  name="code"
                  maxLength={24}
                  autoCapitalize="characters"
                  className="mt-1 block min-h-11 w-full rounded-input border border-line-strong bg-surface px-3 font-mono text-body-sm uppercase text-ink focus-visible:border-brand"
                />
                <span className="mt-1 block text-caption font-normal text-text-muted">
                  {t('codeHint')}
                </span>
              </label>
            )}
            <p className="text-caption text-text-muted">{t('stripeNote')}</p>
            <Button type="submit" block>
              {offersOn && !subscription
                ? t('payWithOffers')
                : t('pay', { amount: formatEuro(plan.priceCents, locale) })}
            </Button>
          </form>
        )}
      </main>
    </AppShell>
  );
}
