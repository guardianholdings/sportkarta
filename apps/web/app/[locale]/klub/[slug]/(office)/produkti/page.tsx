import { clubHasFeature, euroInputValue, formatEuro, lowestTierWith } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { CLUB_PRODUCT_CATEGORIES, CLUB_VAT_RATES } from '@/lib/clubs/input';
import { bestSellers, clubProducts, type ClubProduct } from '@/lib/clubs/shop';
import { formErrorText } from '@/lib/clubs/form-error';

import { archiveProductAction, saveProductAction, stockAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Products and stock (0049, wave B1): what the club sells over the counter,
 * its price and VAT rate, and the stock count — deliveries, write-offs and a
 * shelf count, every one a line in an append-only ledger. A count below zero
 * (sold more than was ever recorded) is shown, never hidden.
 */
export default async function ClubProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'shop.manage');
  const [t, tClub, messages] = await Promise.all([
    getTranslations('ClubShop'),
    getTranslations('Club'),
    clubFormMessages(),
  ]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const small = 'text-caption text-ink-soft';

  if (!featureOn(club, 'shop')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('productsTitle')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {clubHasFeature(club.tier, 'shop')
            ? t('switchedOff')
            : t('upsell', { tier: tClub(`tier.${lowestTierWith('shop')}`) })}
        </p>
      </main>
    );
  }

  const [products, best] = await Promise.all([
    clubProducts(actor, { includeArchived: true }),
    bestSellers(actor, 30),
  ]);

  const productFields = (product: ClubProduct | null) => (
    <>
      <input type="hidden" name="slug" value={slug} />
      {product && <input type="hidden" name="productId" value={product.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          {t('name')}
          <Input
            name="name"
            required
            maxLength={80}
            defaultValue={product?.name ?? ''}
            className="mt-1"
          />
        </label>
        <label className={field}>
          {t('sku')}
          <Input name="sku" maxLength={40} defaultValue={product?.sku ?? ''} className="mt-1" />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className={small}>
          {t('category')}
          <Select name="category" defaultValue={product?.category ?? 'drink'} className="mt-1">
            {CLUB_PRODUCT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`categories.${category}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className={small}>
          {t('price')}
          <Input
            name="price"
            inputMode="decimal"
            required
            defaultValue={product ? euroInputValue(product.priceCents, locale) : ''}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('vat')}
          <Select name="vatRate" defaultValue={String(product?.vatRateBp ?? 2000)} className="mt-1">
            {CLUB_VAT_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {t('vatRate', { percent: rate / 100 })}
              </option>
            ))}
          </Select>
        </label>
        <label className={small}>
          {t('lowStockAt')}
          <Input
            name="lowStockAt"
            type="number"
            min={0}
            defaultValue={product?.lowStockAt ?? ''}
            className="mt-1"
          />
        </label>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-body-sm text-ink">
        <input
          type="checkbox"
          name="trackStock"
          defaultChecked={product ? product.trackStock : true}
          className="size-4 accent-[var(--brand)]"
        />
        {t('trackStock')}
      </label>
    </>
  );

  const live = products.filter((p) => !p.archived);
  const archived = products.filter((p) => p.archived);
  const low = (p: ClubProduct) =>
    p.trackStock && (p.onHand < 0 || (p.lowStockAt !== null && p.onHand <= p.lowStockAt));

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('productsTitle')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('productsIntro')}</p>
      </div>

      {rezultat && (
        <p
          role="status"
          className={
            ['saved', 'stock_saved', 'stock_unchanged'].includes(rezultat)
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

      <section className={section} aria-labelledby="products-h">
        <h2 id="products-h" className="text-h4 font-bold text-ink">
          {t('shelfTitle')}
        </h2>
        {live.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('noProducts')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {live.map((product) => (
              <li key={product.id} id={`pd-${product.id}`} className="py-2 target:bg-brand-subtle">
                <details>
                  <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
                    <span className="min-w-0 flex-1 font-semibold text-ink">{product.name}</span>
                    <span className="font-mono tabular-nums text-ink">
                      {formatEuro(product.priceCents, locale)}
                    </span>
                    {product.trackStock ? (
                      <span
                        className={
                          low(product)
                            ? 'rounded-pill bg-warning-bg px-2 text-caption font-semibold text-ink'
                            : 'text-caption text-text-muted'
                        }
                      >
                        {t('onHand', { count: product.onHand })}
                      </span>
                    ) : (
                      <span className="text-caption text-text-muted">{t('notCounted')}</span>
                    )}
                  </summary>
                  {product.trackStock && (
                    <div className="mt-2 flex flex-wrap gap-3">
                      {(['receive', 'waste', 'count'] as const).map((kind) => (
                        <form key={kind} action={stockAction} className="flex items-end gap-1">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="productId" value={product.id} />
                          <input type="hidden" name="kind" value={kind} />
                          <label className={small}>
                            {t(`stock.${kind}`)}
                            <Input
                              name="quantity"
                              type="number"
                              min={kind === 'count' ? 0 : 1}
                              required
                              size="sm"
                              className="mt-1 w-20"
                            />
                          </label>
                          {kind === 'receive' && (
                            <label className={small}>
                              {t('unitCost')}
                              <Input
                                name="unitCost"
                                inputMode="decimal"
                                size="sm"
                                className="mt-1 w-20"
                              />
                            </label>
                          )}
                          <Button type="submit" variant="secondary" size="sm">
                            {t(`stock.${kind}Save`)}
                          </Button>
                        </form>
                      ))}
                    </div>
                  )}
                  <form action={saveProductAction} className="mt-3 space-y-3">
                    {productFields(product)}
                    <Button type="submit" size="sm">
                      {t('save')}
                    </Button>
                  </form>
                  <form action={archiveProductAction} className="mt-2">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="productId" value={product.id} />
                    <input type="hidden" name="archive" value="1" />
                    <ConfirmButton
                      message={t('archiveConfirm')}
                      className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
                    >
                      {t('archive')}
                    </ConfirmButton>
                  </form>
                </details>
              </li>
            ))}
          </ul>
        )}
        <details className="rounded-card border border-dashed border-line-strong p-3">
          <summary className="cursor-pointer text-body-sm font-semibold text-ink">
            {t('addProduct')}
          </summary>
          <form action={saveProductAction} className="mt-2 space-y-3">
            {productFields(null)}
            <Button type="submit" size="sm">
              {t('addProduct')}
            </Button>
          </form>
        </details>
      </section>

      {best.length > 0 && (
        <section className={section} aria-labelledby="best-h">
          <h2 id="best-h" className="text-h4 font-bold text-ink">
            {t('bestTitle')}
          </h2>
          <ol className="list-decimal space-y-1 pl-5 text-body-sm text-ink">
            {best.map((row) => (
              <li key={row.productId}>
                {row.name} — {t('sold', { count: row.quantity })} ·{' '}
                {formatEuro(row.revenueCents, locale)}
              </li>
            ))}
          </ol>
        </section>
      )}

      {archived.length > 0 && (
        <section className={section} aria-labelledby="archived-h">
          <h2 id="archived-h" className="text-h4 font-bold text-ink">
            {t('archivedTitle')}
          </h2>
          <ul className="divide-y divide-line">
            {archived.map((product) => (
              <li key={product.id} className="flex items-center gap-3 py-2 text-body-sm">
                <span className="min-w-0 flex-1 text-ink-soft">{product.name}</span>
                <form action={archiveProductAction}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="productId" value={product.id} />
                  <input type="hidden" name="archive" value="0" />
                  <Button type="submit" variant="secondary" size="sm">
                    {t('restore')}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
