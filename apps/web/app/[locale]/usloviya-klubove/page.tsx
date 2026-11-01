import {
  CLUB_CONTRACT_MONTHS,
  CLUB_CONTRACT_NOTICE_MONTHS,
  CLUB_GRACE_DAYS,
  CLUB_PURGE_AFTER_DAYS,
  CLUB_TRIAL_DAYS,
} from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';

import { legalLinks } from '@/components/legal/legal-links';
import { OrganisationDetails } from '@/components/legal/organisation-details';
import { AppShell } from '@/components/shell/app-shell';
import { Link } from '@/i18n/navigation';
import { clubsEnabled } from '@/lib/clubs/access';
import { formatDate } from '@/lib/format';
import {
  CLUB_BREACH_NOTICE_HOURS,
  CLUB_LIABILITY_CAP_MONTHS,
  CLUB_TERMS_CHANGE_NOTICE_DAYS,
  CLUB_TERMS_DRAFT,
  CLUB_TERMS_SECTIONS,
  CLUB_TERMS_VERSION,
} from '@/lib/legal-pages';
import { organisation } from '@/lib/organisation';
import { buildAlternates } from '@/lib/seo';

/**
 * «Условия за POPS Клубове» — the contract a club accepts when it applies
 * (/klubove/zayavka), with Annex A, the Art. 28 GDPR data processing agreement
 * (launch audit: the application form made a club accept «условията за
 * ползване на POPS Клубове», /usloviya referred to them, and no such text
 * existed).
 *
 * Structure and version in lib/legal-pages.ts (CLUB_TERMS_SECTIONS,
 * CLUB_TERMS_VERSION); words in messages/*.json under ClubTerms, Bulgarian
 * authoritative and prevailing by its own clause. Every figure the text states
 * is passed in from the constants that run the system — the trial, the term,
 * the notice, the grace after non-payment, the purge after archiving — so the
 * contract cannot promise a number the code does not keep.
 *
 * PUBLIC WHATEVER CLUBS_ENABLED SAYS: a contract text needs no flag, and the
 * static sitemap lists it. Only the link to /za-klubove (which does 404 while
 * the module is off) is rendered as plain text then.
 *
 * Dynamic so the association's identity (ORG_*, CONTACT_EMAIL) applies from the
 * container env without a rebuild.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubTerms' });
  return {
    title: t('title'),
    description: t('metaDescription'),
    alternates: buildAlternates('/usloviya-klubove', locale),
  };
}

export default async function ClubTermsPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('ClubTerms');
  const org = organisation();
  const values = {
    ...legalLinks,
    // /za-klubove answers 404 while the module is off: no dead link in a contract.
    clubsPage: clubsEnabled() ? legalLinks.clubsPage : (chunks: ReactNode) => chunks,
    days: CLUB_TRIAL_DAYS,
    months: CLUB_CONTRACT_MONTHS,
    notice: CLUB_CONTRACT_NOTICE_MONTHS,
    grace: CLUB_GRACE_DAYS,
    purgeDays: CLUB_PURGE_AFTER_DAYS,
    noticeDays: CLUB_TERMS_CHANGE_NOTICE_DAYS,
    capMonths: CLUB_LIABILITY_CAP_MONTHS,
    breachHours: CLUB_BREACH_NOTICE_HOURS,
  };

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('back')}
        </Link>
        <header className="space-y-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-caption text-text-muted">
            {t('updated', { date: formatDate(CLUB_TERMS_VERSION, locale) })}
          </p>
        </header>
        {CLUB_TERMS_DRAFT && (
          <p
            role="note"
            className="rounded-card border border-warning-border bg-warning-bg px-4 py-3 text-body-sm text-warning"
          >
            {t('draftNotice')}
          </p>
        )}
        <p className="text-ink-soft">{t.rich('intro', values)}</p>

        {CLUB_TERMS_SECTIONS.map((section, index) => (
          <section
            key={section.key}
            aria-labelledby={`club-terms-${section.key}`}
            className="space-y-2"
          >
            <h2 id={`club-terms-${section.key}`} className="text-h4 font-bold text-ink">
              {`${String(index + 1)}. `}
              {t(`${section.key}.title`)}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph} className="text-ink-soft">
                {t.rich(`${section.key}.${paragraph}`, values)}
              </p>
            ))}
            {section.items &&
              (section.numbered ? (
                <ol className="list-decimal space-y-2 pl-5 text-ink-soft">
                  {section.items.map((item) => (
                    <li key={item}>{t.rich(`${section.key}.items.${item}`, values)}</li>
                  ))}
                </ol>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-ink-soft">
                  {section.items.map((item) => (
                    <li key={item}>{t.rich(`${section.key}.items.${item}`, values)}</li>
                  ))}
                </ul>
              ))}
            {section.org && <OrganisationDetails org={org} />}
          </section>
        ))}
      </main>
    </AppShell>
  );
}
