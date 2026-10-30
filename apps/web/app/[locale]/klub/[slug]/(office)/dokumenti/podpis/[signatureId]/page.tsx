import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { PrintButton } from '@/components/clubs/print-button';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { signatureForPrint } from '@/lib/clubs/documents';
import { isUuid } from '@/lib/clubs/input';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * One signature, print-ready (0055): the exact text of the version signed,
 * who signed it and how, when, and the SHA-256 the database computed for that
 * text — "Save as PDF" in the browser, no server PDF (the reports' rule).
 */
export default async function ClubSignaturePrintPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string; signatureId: string }>;
}) {
  const { locale, slug, signatureId } = await params;
  setRequestLocale(locale);
  if (!isUuid(signatureId)) notFound();
  const { actor } = await requireClubStaff(slug, 'members.view');
  const [t, signature] = await Promise.all([
    getTranslations('ClubDocuments'),
    signatureForPrint(actor, signatureId),
  ]);
  if (!signature) notFound();
  const row = 'grid gap-1 sm:grid-cols-[12rem_1fr]';
  const label = 'text-caption font-semibold text-ink-soft';

  return (
    <main className="space-y-4">
      <Link
        href={`/klub/${slug}/dokumenti`}
        className="text-body-sm font-semibold text-link hover:text-link-hover print:hidden"
      >
        ← {t('back')}
      </Link>
      <article className="space-y-4 rounded-card border border-line bg-surface p-4 shadow-sm print:border-0 print:shadow-none">
        <header>
          <p className="text-caption text-text-muted">{signature.clubName}</p>
          <h1 className="text-h3 font-extrabold text-ink">{signature.documentTitle}</h1>
          <p className="text-caption text-text-muted">
            {t('versionShort', { version: signature.version })}
          </p>
        </header>
        <div className="whitespace-pre-wrap text-body-sm text-ink">{signature.bodyBg}</div>
        {signature.bodyEn && (
          <div className="whitespace-pre-wrap border-t border-line pt-3 text-body-sm text-ink-soft">
            {signature.bodyEn}
          </div>
        )}
        <dl className="space-y-2 border-t border-line pt-3 text-body-sm">
          <div className={row}>
            <dt className={label}>{t('printClient')}</dt>
            <dd className="text-ink">{signature.memberName}</dd>
          </div>
          <div className={row}>
            <dt className={label}>{t('printSigner')}</dt>
            <dd className="text-ink">
              {signature.signerName} ({t(`signerKinds.${signature.signerKind}`)})
            </dd>
          </div>
          <div className={row}>
            <dt className={label}>{t('printMethod')}</dt>
            <dd className="text-ink">
              {t(`methods.${signature.method}`)}
              {signature.witnessName ? ` · ${t('witness', { name: signature.witnessName })}` : ''}
            </dd>
          </div>
          <div className={row}>
            <dt className={label}>{t('printSignedAt')}</dt>
            <dd className="text-ink">{formatDateTime(signature.signedAt, locale)}</dd>
          </div>
          <div className={row}>
            <dt className={label}>{t('hashLabel')}</dt>
            <dd className="break-all font-mono text-caption text-ink">{signature.sha256}</dd>
          </div>
        </dl>
        <p className="text-caption text-text-muted">{t('printHashHint')}</p>
      </article>
      <div className="flex flex-wrap gap-2 print:hidden">
        <PrintButton
          label={t('printButton')}
          className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-line-strong px-4 text-body-sm font-semibold text-ink hover:bg-surface-2 [&_svg]:size-4"
        />
      </div>
    </main>
  );
}
