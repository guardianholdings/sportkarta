import {
  PROMOTION_KINDS,
  PROMOTION_TARGETS,
  addDaysIso,
  clubHasFeature,
  formatEuro,
  lowestTierWith,
  sofiaToday,
  type Promotion,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { clubPromotions } from '@/lib/clubs/promotions';
import { listPlans } from '@/lib/clubs/sales';
import { clubProducts } from '@/lib/clubs/shop';
import { formatDate } from '@/lib/format';
import { formErrorText } from '@/lib/clubs/form-error';

import { archivePromotionAction, createVoucherAction, savePromotionAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Offers and gift vouchers (0049, wave B1): a code typed at the desk or
 * online, or an automatic offer the club page shows struck through; percent,
 * an amount off, or a fixed price; caps, new clients only, a loyalty
 * threshold. One offer per purchase — the best for the buyer.
 */
export default async function ClubPromotionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'plans.manage');
  const [t, tClub, messages] = await Promise.all([
    getTranslations('ClubPromotions'),
    getTranslations('Club'),
    clubFormMessages(),
  ]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const small = 'text-caption text-ink-soft';

  if (!clubHasFeature(club.tier, 'promotions')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {t('upsell', { tier: tClub(`tier.${lowestTierWith('promotions')}`) })}
        </p>
      </main>
    );
  }

  const shop = featureOn(club, 'shop');
  const [promotions, plans, products] = await Promise.all([
    clubPromotions(actor),
    listPlans(actor),
    shop ? clubProducts(actor) : Promise.resolve([]),
  ]);
  const today = sofiaToday();
  const value = (p: Promotion) =>
    p.kind === 'percent'
      ? t('valuePercent', { percent: (p.value / 100).toLocaleString(locale) })
      : p.kind === 'amount'
        ? t('valueAmount', { amount: formatEuro(p.value, locale) })
        : t('valueFixed', { amount: formatEuro(p.value, locale) });
  const status = (p: Promotion & { archived: boolean }) =>
    p.archived
      ? 'archived'
      : today < p.startsOn
        ? 'upcoming'
        : p.endsOn !== null && today > p.endsOn
          ? 'ended'
          : p.maxUses !== null && p.uses >= p.maxUses
            ? 'used_up'
            : 'active';

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      {rezultat && (
        <p
          role="status"
          className={
            rezultat === 'saved' || rezultat === 'voucher_created'
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {t.has(`outcome.${rezultat}`)
            ? t(`outcome.${rezultat}`)
            : rezultat === 'readOnly'
              ? messages.readOnly
              : formErrorText(messages, rezultat)}
        </p>
      )}

      <section className={section} aria-labelledby="list-h">
        <h2 id="list-h" className="text-h4 font-bold text-ink">
          {t('listTitle')}
        </h2>
        {promotions.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {promotions.map((p) => (
              <li
                key={p.id}
                id={`po-${p.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 target:bg-brand-subtle"
              >
                <span className="min-w-0 flex-1 text-body-sm">
                  <span className="font-semibold text-ink">{p.name}</span>
                  <span className="block text-caption text-text-muted">
                    {p.code ? <span className="font-mono text-ink">{p.code}</span> : t('automatic')}
                    {' · '}
                    {value(p)}
                    {' · '}
                    {t(`targets.${p.target}`)}
                    {' · '}
                    {formatDate(p.startsOn, locale)}
                    {p.endsOn ? ` – ${formatDate(p.endsOn, locale)}` : ''}
                    {' · '}
                    {p.maxUses !== null
                      ? t('usesOf', { uses: p.uses, max: p.maxUses })
                      : t('uses', { uses: p.uses })}
                    {p.newMembersOnly ? ` · ${t('newOnly')}` : ''}
                    {p.minVisits90d !== null
                      ? ` · ${t('loyalty', { visits: p.minVisits90d })}`
                      : ''}
                  </span>
                </span>
                <span className="text-caption font-semibold text-ink-soft">
                  {t(`status.${status(p)}`)}
                </span>
                {!p.archived && (
                  <form action={archivePromotionAction}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="promotionId" value={p.id} />
                    <ConfirmButton
                      message={t('archiveConfirm')}
                      className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
                    >
                      {t('archive')}
                    </ConfirmButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={section} aria-labelledby="voucher-h">
        <h2 id="voucher-h" className="text-h4 font-bold text-ink">
          {t('voucherTitle')}
        </h2>
        <p className="text-caption text-text-muted">{t('voucherHint')}</p>
        <form action={createVoucherAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="slug" value={slug} />
          <label className={small}>
            {t('voucherAmount')}
            <Input name="amount" inputMode="decimal" required size="sm" className="mt-1 w-28" />
          </label>
          <label className={small}>
            {t('validUntil')}
            <Input
              name="endsOn"
              type="date"
              size="sm"
              min={today}
              defaultValue={addDaysIso(today, 365)}
              className="mt-1"
            />
          </label>
          <Button type="submit" size="sm">
            {t('createVoucher')}
          </Button>
        </form>
      </section>

      <section className={section} aria-labelledby="new-h">
        <h2 id="new-h" className="text-h4 font-bold text-ink">
          {t('newTitle')}
        </h2>
        <form action={savePromotionAction} className="space-y-3">
          <input type="hidden" name="slug" value={slug} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={field}>
              {t('name')}
              <Input name="name" required maxLength={80} className="mt-1" />
            </label>
            <label className={field}>
              {t('code')}
              <Input
                name="code"
                maxLength={24}
                autoCapitalize="characters"
                className="mt-1 font-mono uppercase"
              />
              <span className="mt-1 block text-caption font-normal text-text-muted">
                {t('codeHint')}
              </span>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={small}>
              {t('kind')}
              <Select name="kind" defaultValue="percent" className="mt-1">
                {PROMOTION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`kinds.${kind}`)}
                  </option>
                ))}
              </Select>
            </label>
            <label className={small}>
              {t('value')}
              <Input name="value" inputMode="decimal" required className="mt-1" />
              <span className="mt-1 block text-caption text-text-muted">{t('valueHint')}</span>
            </label>
            <label className={small}>
              {t('target')}
              <Select name="target" defaultValue="all" className="mt-1">
                {PROMOTION_TARGETS.filter((target) => shop || target !== 'products').map(
                  (target) => (
                    <option key={target} value={target}>
                      {t(`targets.${target}`)}
                    </option>
                  ),
                )}
              </Select>
            </label>
          </div>
          {(plans.length > 0 || products.length > 0) && (
            <details className="rounded-card border border-dashed border-line-strong p-3">
              <summary className="cursor-pointer text-body-sm font-semibold text-ink">
                {t('onlySome')}
              </summary>
              <p className="mt-1 text-caption text-text-muted">{t('onlySomeHint')}</p>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {plans.map((plan) => (
                  <label key={plan.id} className="flex min-h-9 items-center gap-2 text-body-sm">
                    <input
                      type="checkbox"
                      name="targetIds"
                      value={plan.id}
                      className="size-4 accent-[var(--brand)]"
                    />
                    {plan.nameBg} · {formatEuro(plan.priceCents, locale)}
                  </label>
                ))}
                {products.map((product) => (
                  <label key={product.id} className="flex min-h-9 items-center gap-2 text-body-sm">
                    <input
                      type="checkbox"
                      name="targetIds"
                      value={product.id}
                      className="size-4 accent-[var(--brand)]"
                    />
                    {product.name} · {formatEuro(product.priceCents, locale)}
                  </label>
                ))}
              </div>
            </details>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={small}>
              {t('startsOn')}
              <Input name="startsOn" type="date" defaultValue={today} className="mt-1" />
            </label>
            <label className={small}>
              {t('endsOn')}
              <Input name="endsOn" type="date" min={today} className="mt-1" />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={small}>
              {t('maxUses')}
              <Input name="maxUses" type="number" min={1} className="mt-1" />
            </label>
            <label className={small}>
              {t('perMemberMax')}
              <Input name="perMemberMax" type="number" min={1} className="mt-1" />
            </label>
            <label className={small}>
              {t('minVisits')}
              <Input name="minVisits" type="number" min={1} max={365} className="mt-1" />
            </label>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-body-sm text-ink">
            <input type="checkbox" name="newMembersOnly" className="size-4 accent-[var(--brand)]" />
            {t('newMembersOnly')}
          </label>
          <p className="text-caption text-text-muted">{t('rulesHint')}</p>
          <Button type="submit">{t('save')}</Button>
        </form>
      </section>
    </main>
  );
}
