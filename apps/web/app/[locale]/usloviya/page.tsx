import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { legalLinks } from '@/components/legal/legal-links';
import { OrganisationDetails } from '@/components/legal/organisation-details';
import { AppShell } from '@/components/shell/app-shell';
import { Link } from '@/i18n/navigation';
import { TERMS_SECTIONS } from '@/lib/legal-pages';
import { organisation } from '@/lib/organisation';
import { buildAlternates } from '@/lib/seo';

/**
 * «Общи условия» — the terms of use (pre-launch audit: there were none).
 *
 * They exist for four reasons the code cannot supply on its own: a contract to
 * rest account processing on (GDPR Art. 6(1)(b)); a licence from contributors
 * for what the open-data dumps already publish under ODbL, and for the photos
 * the dumps deliberately exclude; published content rules and a description of
 * moderation (DSA Art. 14), which is what a statement of reasons (Art. 17)
 * points at; and a plain statement that facility data may be wrong and that
 * people play at their own risk.
 *
 * Bulgarian is the authoritative text (messages/bg.json), English mirrors it.
 * The words describe what the code DOES — e.g. that a crowd-added facility is
 * public at once and marked unverified, that photos wait for a moderator — so
 * a change to either behaviour is a change to this page too.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Terms' });
  return {
    title: t('title'),
    description: t('metaDescription'),
    alternates: buildAlternates('/usloviya', locale),
  };
}

export default async function TermsPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Terms');
  const org = organisation();

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('back')}
        </Link>
        <header className="space-y-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-caption text-text-muted">{t('updated')}</p>
        </header>
        <p className="text-ink-soft">{t.rich('intro', legalLinks)}</p>

        {TERMS_SECTIONS.map((section, index) => (
          <section key={section.key} aria-labelledby={`terms-${section.key}`} className="space-y-2">
            <h2 id={`terms-${section.key}`} className="text-h4 font-bold text-ink">
              {`${String(index + 1)}. `}
              {t(`${section.key}.title`)}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph} className="text-ink-soft">
                {t.rich(`${section.key}.${paragraph}`, legalLinks)}
              </p>
            ))}
            {section.items && (
              <ul className="list-disc space-y-1 pl-5 text-ink-soft">
                {section.items.map((item) => (
                  <li key={item}>{t(`${section.key}.items.${item}`)}</li>
                ))}
              </ul>
            )}
            {section.org && <OrganisationDetails org={org} />}
          </section>
        ))}
      </main>
    </AppShell>
  );
}
