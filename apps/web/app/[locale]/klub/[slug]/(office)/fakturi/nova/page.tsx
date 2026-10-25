import { documentRate, formatEuro, INVOICE_DOCUMENT } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link, redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { invoiceDraft } from '@/lib/clubs/invoices';

import { issueInvoiceAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Issue a charge's invoice (0050): the lines, the VAT split and the totals as
 * the document will print them, and who it is made out to. The office checks
 * the draft; the server computes it again when issuing.
 */
export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ zadalzhenie?: string; rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'invoices.issue');
  const { zadalzhenie, rezultat } = await searchParams;
  if (!featureOn(club, 'invoices') || !isUuid(zadalzhenie)) notFound();
  const draft = await invoiceDraft(actor, zadalzhenie);
  if (!draft) notFound();
  if (draft.existingInvoiceId) {
    return redirect({ href: `/klub/${slug}/fakturi/${draft.existingInvoiceId}`, locale });
  }
  const [t, messages] = await Promise.all([getTranslations('ClubInvoices'), clubFormMessages()]);
  const doc = INVOICE_DOCUMENT;
  const label = 'block text-body-sm font-semibold text-ink';
  const problem = rezultat ? (messages.errors[rezultat] ?? messages.genericError) : null;

  return (
    <main className="mx-auto max-w-2xl space-y-4">
      <Link
        href={`/klub/${slug}/fakturi`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('title')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('newTitle')}</h1>
      {problem && (
        <p
          role="alert"
          className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
        >
          {problem}
        </p>
      )}
      {!draft.supplier ? (
        <p className="rounded-card border border-warning-border bg-warning-bg p-3 text-body-sm text-ink">
          {t('detailsMissing')}{' '}
          <Link
            href={`/klub/${slug}/nastroyki#fakturi`}
            className="font-semibold text-link hover:text-link-hover"
          >
            {t('detailsLink')}
          </Link>
        </p>
      ) : (
        <>
          <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
            <h2 className="text-h4 font-bold text-ink">{t('draft')}</h2>
            <table className="w-full text-body-sm">
              <tbody className="divide-y divide-line">
                {draft.lines.map((line, i) => (
                  <tr key={i}>
                    <td className="py-1.5 text-ink">
                      {line.description}
                      <span className="block text-caption text-text-muted">
                        {line.quantity} × {formatEuro(line.unitPriceCents, locale)}
                        {line.discountCents > 0
                          ? ` − ${formatEuro(line.discountCents, locale)}`
                          : ''}
                        {line.vatRateBp !== null
                          ? ` · ${doc.vatAt} ${documentRate(line.vatRateBp)}`
                          : ''}
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-ink">
                      {formatEuro(line.totalCents, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {draft.totals.vatCents > 0 && (
              <p className="flex justify-between text-body-sm text-ink-soft">
                <span>{t('vatIncluded')}</span>
                <span className="font-mono tabular-nums">
                  {formatEuro(draft.totals.vatCents, locale)}
                </span>
              </p>
            )}
            <p className="flex justify-between text-body font-bold text-ink">
              <span>{t('total')}</span>
              <span className="font-mono tabular-nums">
                {formatEuro(draft.totals.totalCents, locale)}
              </span>
            </p>
            <p className="text-caption text-text-muted">
              {draft.supplier.vatNumber ? t('vatRegistered') : t('notVatRegistered')}
            </p>
          </section>

          <form
            action={issueInvoiceAction}
            className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm"
          >
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="chargeId" value={draft.chargeId} />
            <fieldset className="space-y-1">
              <legend className={label}>{t('buyer')}</legend>
              <div className="flex flex-wrap gap-2">
                {(['person', 'company'] as const).map((kind) => (
                  <label
                    key={kind}
                    className="flex min-h-11 items-center gap-2 rounded-pill border border-line-strong px-4 text-body-sm text-ink has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
                  >
                    <input
                      type="radio"
                      name="buyerKind"
                      value={kind}
                      defaultChecked={kind === 'person'}
                      className="size-4 accent-[var(--brand)]"
                    />
                    {t(`buyerKind.${kind}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className={label}>
              {t('buyerName')}
              <Input
                name="buyerName"
                required
                maxLength={200}
                defaultValue={draft.memberName ?? ''}
                className="mt-1"
              />
            </label>
            <label className={label}>
              {t('buyerAddress')}
              <Input name="buyerAddress" maxLength={300} className="mt-1" />
              <span className="mt-1 block text-caption font-normal text-text-muted">
                {t('buyerAddressHint')}
              </span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={label}>
                {t('buyerEik')}
                <Input name="buyerEik" inputMode="numeric" maxLength={13} className="mt-1" />
              </label>
              <label className={label}>
                {t('buyerVatNumber')}
                <Input name="buyerVatNumber" maxLength={15} className="mt-1 uppercase" />
              </label>
            </div>
            <p className="text-caption text-text-muted">{t('companyHint')}</p>
            <Button type="submit">{t('issue')}</Button>
            <p className="text-caption text-text-muted">{t('issueNote')}</p>
          </form>
        </>
      )}
    </main>
  );
}
