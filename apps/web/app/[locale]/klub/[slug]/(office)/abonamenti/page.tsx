import { formatEuro } from '@sportkarta/lib/clubs';
import { Plus, ShoppingCart } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { listPlans } from '@/lib/clubs/sales';

import { setPlanArchivedAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function ClubPlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ arhiv?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'sales.manage');
  const { arhiv } = await searchParams;
  const showArchived = arhiv === '1';
  const [t, tClub, plans] = await Promise.all([
    getTranslations('ClubSales'),
    getTranslations('Club'),
    listPlans(actor, { includeArchived: showArchived }),
  ]);
  const manage = actorCan(actor, 'plans.manage');
  const base = `/klub/${slug}/abonamenti`;

  return (
    <main className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('plansTitle')}</h1>
          <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{t('plansIntro')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`${base}/prodazhba`} className={buttonVariants({ variant: 'accent' })}>
            <ShoppingCart aria-hidden="true" />
            {t('sell')}
          </Link>
          {manage && (
            <Link href={`${base}/nov`} className={buttonVariants({ variant: 'secondary' })}>
              <Plus aria-hidden="true" />
              {t('newPlan')}
            </Link>
          )}
        </div>
      </div>

      {plans.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
          {t('noPlans')}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {plans.map((plan) => (
            <li
              key={plan.id}
              className={`space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm ${plan.archived ? 'opacity-70' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-body font-bold text-ink">
                    {locale === 'en' && plan.nameEn ? plan.nameEn : plan.nameBg}{' '}
                    {plan.archived && <Badge tone="neutral">{t('archived')}</Badge>}
                  </h2>
                  <p className="text-caption text-text-muted">
                    {tClub(`planKind.${plan.kind}`)} ·{' '}
                    {t('validity', {
                      amount: plan.validityMonths ?? plan.validityDays ?? 0,
                      unit: plan.validityMonths ? 'months' : 'days',
                    })}
                    {plan.visitsCount ? ` · ${t('visits', { count: plan.visitsCount })}` : ''}
                    {plan.audience !== 'all' ? ` · ${tClub(`audience.${plan.audience}`)}` : ''}
                    {plan.visibility === 'private' ? ` · ${t('private')}` : ''}
                  </p>
                </div>
                <span className="font-mono text-h4 font-semibold tabular-nums text-ink">
                  {formatEuro(plan.priceCents, locale)}
                </span>
              </div>
              <p className="text-caption text-text-muted">
                {t('liveCount', { count: plan.liveCount })}
              </p>
              <div className="flex flex-wrap gap-2">
                {!plan.archived && (
                  <Link
                    href={{ pathname: `${base}/prodazhba`, query: { plan: plan.id } }}
                    className={buttonVariants({ variant: 'primary', size: 'sm' })}
                  >
                    {t('sell')}
                  </Link>
                )}
                {manage && (
                  <>
                    <Link
                      href={`${base}/${plan.id}`}
                      className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                    >
                      {t('edit')}
                    </Link>
                    <form action={setPlanArchivedAction}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="planId" value={plan.id} />
                      <input
                        type="hidden"
                        name="archived"
                        value={plan.archived ? 'false' : 'true'}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        {plan.archived ? t('restore') : t('archive')}
                      </Button>
                    </form>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!showArchived && manage && (
        <Link
          href={{ pathname: base, query: { arhiv: '1' } }}
          className="text-body-sm font-semibold text-link"
        >
          {t('showArchived')}
        </Link>
      )}
    </main>
  );
}
