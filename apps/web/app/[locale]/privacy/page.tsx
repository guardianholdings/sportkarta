import { NOTIFIER_CONTACT_RETENTION_DAYS } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';

import { externalLink, legalLinks } from '@/components/legal/legal-links';
import { OrganisationDetails } from '@/components/legal/organisation-details';
import { AppShell } from '@/components/shell/app-shell';
import { Link } from '@/i18n/navigation';
import { enabledSignInProviders, SIGN_IN_PROVIDER_NAMES } from '@/lib/auth-config';
import { OTP_TTL_SECONDS } from '@/lib/auth-surface';
import {
  PRIVACY_ACTIVITIES,
  PRIVACY_PROVIDER_ONLY,
  PRIVACY_RECIPIENTS,
  PRIVACY_RETENTION,
} from '@/lib/legal-pages';
import { organisation } from '@/lib/organisation';
import { buildAlternates } from '@/lib/seo';

/**
 * «Поверителност» — the GDPR Art. 13 notice.
 *
 * The pre-launch audit found seven short paragraphs that named no controller,
 * no legal basis, no recipient, no retention and no rights, and that said
 * nothing about most of what the product processes (training logs, the
 * location-derived distances, public passports and boards, session and digest
 * mail, the moderation and access logs, the session user agent). This page is
 * the rewrite: every processing activity with its purpose and legal basis, the
 * recipients and the transfers outside the EU, how long each thing is kept,
 * the rights and the regulator, cookies, minors and automated decisions.
 *
 * IT DESCRIBES THE CODE, so the code is its source: the retention figures below
 * mirror auth.ts (sign-in codes live OTP_TTL_SECONDS, sessions 30 days), the
 * worker's nightly cleanup, deploy/backup/backup.sh (14 days local, 14 daily +
 * 8 weekly off-box), NOTIFIER_CONTACT_RETENTION_DAYS and OTP_TTL_SECONDS — both
 * passed in rather than typed into the messages so they cannot drift — and the
 * sign-in providers that are switched on. Change a behaviour, change this page.
 *
 * Dynamic so the controller's identity (ORG_*, CONTACT_EMAIL) applies from the
 * container env without a rebuild; the page itself holds no user data.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Privacy' });
  return {
    title: t('title'),
    description: t('metaDescription'),
    alternates: buildAlternates('/privacy', locale),
  };
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`privacy-${id}`} className="space-y-2">
      <h2 id={`privacy-${id}`} className="text-h4 font-bold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function PrivacyPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Privacy');
  const org = organisation();
  // Only the providers that are on are named, and their paragraphs are printed
  // only while at least one is: with every flag off the notice is unchanged.
  const providers = enabledSignInProviders(process.env);
  const providerNames = new Intl.ListFormat(locale, { type: 'disjunction' }).format(
    providers.map((provider) => SIGN_IN_PROVIDER_NAMES[provider]),
  );
  const printed = (key: string) => providers.length > 0 || !PRIVACY_PROVIDER_ONLY.has(key);
  const rich = {
    ...legalLinks,
    days: NOTIFIER_CONTACT_RETENTION_DAYS,
    minutes: OTP_TTL_SECONDS / 60,
    providers: providerNames,
  };

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
        <p className="text-ink-soft">{t('intro')}</p>

        <Section id="controller" title={t('controller.title')}>
          <p className="text-ink-soft">{t('controller.body')}</p>
          <OrganisationDetails org={org} />
        </Section>

        <Section id="processing" title={t('processing.title')}>
          <p className="text-ink-soft">{t('processing.intro')}</p>
          <dl className="space-y-3">
            {PRIVACY_ACTIVITIES.filter(printed).map((key) => (
              <div key={key} className="space-y-0.5">
                <dt className="font-semibold text-ink">
                  {t(`processing.${key}.title`, { providers: providerNames })}
                </dt>
                <dd className="text-ink-soft">{t.rich(`processing.${key}.body`, rich)}</dd>
                <dd className="text-caption text-text-muted">
                  {t.rich(`processing.${key}.basis`, rich)}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section id="recipients" title={t('recipients.title')}>
          <p className="text-ink-soft">{t('recipients.intro')}</p>
          <ul className="list-disc space-y-2 pl-5 text-ink-soft">
            {PRIVACY_RECIPIENTS.filter(printed).map((key) => (
              <li key={key}>{t.rich(`recipients.${key}`, rich)}</li>
            ))}
          </ul>
        </Section>

        <Section id="transfers" title={t('transfers.title')}>
          <p className="text-ink-soft">{t('transfers.body')}</p>
        </Section>

        <Section id="retention" title={t('retention.title')}>
          <ul className="list-disc space-y-2 pl-5 text-ink-soft">
            {PRIVACY_RETENTION.map((key) => (
              <li key={key}>{t.rich(`retention.${key}`, rich)}</li>
            ))}
          </ul>
        </Section>

        <Section id="rights" title={t('rights.title')}>
          <p className="text-ink-soft">{t('rights.body')}</p>
          <p className="text-ink-soft">{t.rich('rights.self', rich)}</p>
          <p className="text-ink-soft">{t.rich('rights.ask', rich)}</p>
          <p className="text-ink-soft">
            {t.rich('rights.complaint', { cpdp: externalLink('https://www.cpdp.bg/') })}
          </p>
        </Section>

        <Section id="cookies" title={t('cookies.title')}>
          <p className="text-ink-soft">{t('cookies.body')}</p>
          {providers.length > 0 && (
            <p className="text-ink-soft">{t('cookies.providers', { providers: providerNames })}</p>
          )}
          <p className="text-ink-soft">{t('cookies.cache')}</p>
        </Section>

        <Section id="minors" title={t('minors.title')}>
          <p className="text-ink-soft">{t('minors.body')}</p>
        </Section>

        <Section id="automated" title={t('automated.title')}>
          <p className="text-ink-soft">{t('automated.body')}</p>
        </Section>

        <Section id="sources" title={t('sources.title')}>
          <p className="text-ink-soft">{t.rich('sources.body', rich)}</p>
        </Section>

        <Section id="changes" title={t('changes.title')}>
          <p className="text-ink-soft">{t('changes.body')}</p>
        </Section>
      </main>
    </AppShell>
  );
}
