import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { OrganisationDetails } from '@/components/legal/organisation-details';
import { AppShell } from '@/components/shell/app-shell';
import { Link } from '@/i18n/navigation';
import { organisation } from '@/lib/organisation';
import { buildAlternates } from '@/lib/seo';

/**
 * «Контакт» — the imprint: who runs POPS and the one place to reach them.
 *
 * GDPR Art. 13(1)(a) wants the controller's identity and contact details, DSA
 * Arts. 11-12 a single point of contact for authorities and for users (with
 * the languages it accepts), and — if POPS counts as an information-society
 * service — ЗЕТ чл. 4 the provider's name, seat and registration number. All
 * three are the same few lines, so they live on one page that the footer, the
 * privacy notice and the terms point at.
 *
 * Dynamic so the ORG_* and CONTACT_EMAIL variables apply from the container
 * env without a rebuild; the page itself holds no user data.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Contact' });
  return {
    title: t('title'),
    description: t('metaDescription'),
    alternates: buildAlternates('/kontakt', locale),
  };
}

const LINK = 'font-medium text-link hover:text-link-hover';

export default async function ContactPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Contact');
  const org = organisation();

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('back')}
        </Link>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="text-ink-soft">{t('intro')}</p>

        <section aria-labelledby="org-h" className="space-y-2">
          <h2 id="org-h" className="text-h4 font-bold text-ink">
            {t('orgTitle')}
          </h2>
          <OrganisationDetails org={org} />
        </section>

        <section aria-labelledby="dsa-h" className="space-y-1">
          <h2 id="dsa-h" className="text-h4 font-bold text-ink">
            {t('pointTitle')}
          </h2>
          <p className="text-ink-soft">{t('pointBody')}</p>
        </section>

        <section aria-labelledby="topics-h" className="space-y-2">
          <h2 id="topics-h" className="text-h4 font-bold text-ink">
            {t('topicsTitle')}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-ink-soft">
            <li>
              {t.rich('topicData', {
                privacy: (chunks) => (
                  <Link href="/privacy" className={LINK}>
                    {chunks}
                  </Link>
                ),
              })}
            </li>
            <li>
              {t.rich('topicContent', {
                form: (chunks) => (
                  <Link href="/signal" className={LINK}>
                    {chunks}
                  </Link>
                ),
              })}
            </li>
            <li>{t('topicFacility')}</li>
            <li>
              {t.rich('topicSupport', {
                support: (chunks) => (
                  <Link href="/podkrepi" className={LINK}>
                    {chunks}
                  </Link>
                ),
                partners: (chunks) => (
                  <Link href="/partnyori" className={LINK}>
                    {chunks}
                  </Link>
                ),
              })}
            </li>
          </ul>
        </section>

        <p className="text-body-sm text-ink-soft">
          {t.rich('legalLinks', {
            terms: (chunks) => (
              <Link href="/usloviya" className={LINK}>
                {chunks}
              </Link>
            ),
            privacy: (chunks) => (
              <Link href="/privacy" className={LINK}>
                {chunks}
              </Link>
            ),
          })}
        </p>
      </main>
    </AppShell>
  );
}
