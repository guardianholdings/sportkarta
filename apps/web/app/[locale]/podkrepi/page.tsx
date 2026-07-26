import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AppShell } from '@/components/shell/app-shell';
import { donationDetails } from '@/lib/donations';
import { buildAlternates } from '@/lib/seo';
import { Link } from '@/i18n/navigation';

/**
 * «Подкрепи ни» — the donations page (docs/MONETISATION.md S4, phase M1).
 *
 * A PROSE PAGE THAT TAKES NO MONEY, following the privacy-page recipe. The
 * whole design decision is in what is absent: there is no payment form, no
 * processor script, no iframe. A card widget would be the first third-party
 * script on a cookieless site whose privacy page promises no tracking — it
 * would buy a consent banner for the price of a donation button. So the page
 * publishes an IBAN, and if the operator ever configures
 * `DONATION_PAYMENT_URL` it links OUT to a processor-hosted page where the
 * processor's cookies live on the processor's domain.
 *
 * Bank details come from the environment (never a constant in the repo — an
 * IBAN in git history is forever) and the page degrades to "write to us" when
 * they are absent or malformed, rather than printing an account number a
 * transfer would bounce off. See lib/donations.ts.
 *
 * The tax section is INFORMATION, not advice: it names the articles and then
 * tells the reader to confirm with their accountant. Donor relief depends on
 * public-benefit registration, which the page states as a checkable fact about
 * the register rather than as a claim about our own status.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Podkrepi' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates('/podkrepi', locale),
  };
}

export default async function SupportPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Podkrepi');
  const details = donationDetails();
  const contactEmail = process.env.CONTACT_EMAIL;

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('back')}
        </Link>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="text-ink-soft">{t('intro')}</p>

        <section className="space-y-1">
          <h2 className="text-h4 font-bold text-ink">{t('fundsTitle')}</h2>
          <p className="text-ink-soft">{t('fundsBody')}</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-h4 font-bold text-ink">{t('bankTitle')}</h2>
          <p className="text-ink-soft">{t('bankIntro')}</p>
          {details ? (
            <dl className="grid gap-2 rounded-card border border-line bg-surface p-4 text-body-sm sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium text-text-muted">{t('bankBeneficiary')}</dt>
              <dd className="text-ink">{details.beneficiary}</dd>
              <dt className="font-medium text-text-muted">{t('bankIban')}</dt>
              {/* Selectable and unwrapped: this string gets copied into a
                  banking app, and a line break in the middle of an IBAN is a
                  failed transfer. */}
              <dd className="break-all font-mono text-ink">{details.iban}</dd>
              {details.bic && (
                <>
                  <dt className="font-medium text-text-muted">{t('bankBic')}</dt>
                  <dd className="font-mono text-ink">{details.bic}</dd>
                </>
              )}
              {details.reference && (
                <>
                  <dt className="font-medium text-text-muted">{t('bankReference')}</dt>
                  <dd className="text-ink">{details.reference}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="rounded-card border border-line bg-paper-sunk p-4 text-body-sm text-ink-soft">
              {t('bankFallback')}
            </p>
          )}
        </section>

        {details?.paymentUrl && (
          <section className="space-y-2">
            <h2 className="text-h4 font-bold text-ink">{t('cardTitle')}</h2>
            <p className="text-ink-soft">{t('cardBody')}</p>
            <p className="text-body-sm">
              <a
                href={details.paymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-link hover:text-link-hover"
              >
                {t('cardLink')}
              </a>
            </p>
          </section>
        )}

        <section className="space-y-1">
          <h2 className="text-h4 font-bold text-ink">{t('taxTitle')}</h2>
          <p className="text-ink-soft">{t('taxBody')}</p>
          <ul className="list-disc space-y-1 pl-5 text-ink-soft">
            <li>{t('taxCompanies')}</li>
            <li>{t('taxIndividuals')}</li>
          </ul>
          <p className="text-ink-soft">{t('taxRegister')}</p>
          <p className="text-caption text-text-muted">{t('taxVerify')}</p>
        </section>

        <section className="space-y-1">
          <h2 className="text-h4 font-bold text-ink">{t('contractTitle')}</h2>
          <p className="text-ink-soft">{t('contractBody')}</p>
          {contactEmail ? (
            <p>
              <a
                href={`mailto:${contactEmail}`}
                className="font-medium text-link hover:text-link-hover"
              >
                {contactEmail}
              </a>
            </p>
          ) : (
            <p className="text-ink-soft">{t('contactFallback')}</p>
          )}
          <p className="text-body-sm">
            <Link href="/partnyori" className="font-medium text-link hover:text-link-hover">
              {t('partnersLink')}
            </Link>
          </p>
        </section>
      </main>
    </AppShell>
  );
}
