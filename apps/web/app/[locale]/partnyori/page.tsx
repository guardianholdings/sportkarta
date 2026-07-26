import { getDb } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AppShell } from '@/components/shell/app-shell';
import { partnerText, publicPartners, type PartnerRow, type PartnerTier } from '@/lib/partners';
import { buildAlternates } from '@/lib/seo';
import { Link } from '@/i18n/navigation';

/**
 * The public partners & sponsors page (docs/MONETISATION.md M1) — the page a
 * sponsor's logo is on, and the enabler for every monetisation conversation.
 *
 * Everything shown is DATA from the partners registry (bilingual columns,
 * operator-authored); the page itself only contributes the frame: what
 * partnership means per tier, and how to become one. Outbound partner links
 * carry rel="sponsored noopener" — selling followed links is a link-scheme
 * violation, and the collateral damage would land on the /igrishta SEO pages.
 *
 * Transparency is part of the design (MONETISATION §Ongoing): every partner
 * and sponsor is listed here, always — the disclosure line says so.
 */
export const dynamic = 'force-dynamic';

const TIER_ORDER: PartnerTier[] = ['headline', 'category', 'supporter', 'institutional'];

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Partners' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates('/partnyori', locale),
  };
}

function PartnerCard({ partner, locale }: { partner: PartnerRow; locale: string }) {
  const name = partnerText(partner.nameBg, partner.nameEn, locale) ?? partner.nameBg;
  const blurb = partnerText(partner.blurbBg, partner.blurbEn, locale);
  const body = (
    <div className="flex items-start gap-4">
      {partner.logoPath ? (
        /* eslint-disable-next-line @next/next/no-img-element -- row-decides
           route on our own origin; a fixed 64px logo gains nothing from next/image */
        <img
          src={`/api/partners/logo/${String(partner.id)}`}
          alt={name}
          width={64}
          height={64}
          className="size-16 shrink-0 rounded-md border border-line bg-surface object-contain p-1"
        />
      ) : (
        <div
          aria-hidden
          className="grid size-16 shrink-0 place-items-center rounded-md border border-line bg-paper-sunk text-h4 font-bold text-text-faint"
        >
          {name.slice(0, 1)}
        </div>
      )}
      <div className="min-w-0 space-y-1">
        <p className="text-body font-semibold text-ink">{name}</p>
        {blurb && <p className="text-body-sm text-ink-soft">{blurb}</p>}
      </div>
    </div>
  );

  return (
    <article className="rounded-card border border-line bg-surface p-4 shadow-sm">
      {partner.url ? (
        <a href={partner.url} target="_blank" rel="sponsored noopener" className="block hover:opacity-90">
          {body}
        </a>
      ) : (
        body
      )}
    </article>
  );
}

export default async function PartnersPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Partners');
  const partners = await publicPartners(getDb());
  const contactEmail = process.env.CONTACT_EMAIL;

  const byTier = new Map<PartnerTier, PartnerRow[]>();
  for (const p of partners) {
    byTier.set(p.tier, [...(byTier.get(p.tier) ?? []), p]);
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-3xl space-y-10 p-4">
        <header className="space-y-2">
          <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
            {t('back')}
          </Link>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-ink-soft">{t('intro')}</p>
        </header>

        {partners.length === 0 && (
          <p className="rounded-card border border-line bg-surface px-6 py-12 text-center text-body-sm text-text-muted">
            {t('empty')}
          </p>
        )}

        {TIER_ORDER.map((tier) => {
          const rows = byTier.get(tier);
          if (!rows || rows.length === 0) return null;
          return (
            <section key={tier} aria-labelledby={`tier-${tier}`} className="space-y-3">
              <div className="space-y-1">
                <h2 id={`tier-${tier}`} className="text-h4 font-bold text-ink">
                  {t(`tierTitle_${tier}`)}
                </h2>
                <p className="text-body-sm text-text-muted">{t(`tierIntro_${tier}`)}</p>
              </div>
              <div className={tier === 'headline' ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-2'}>
                {rows.map((p) => (
                  <PartnerCard key={p.id} partner={p} locale={locale} />
                ))}
              </div>
            </section>
          );
        })}

        <section
          aria-labelledby="become-h"
          className="space-y-2 rounded-card border border-brand-border bg-brand-subtle p-5"
        >
          <h2 id="become-h" className="text-h4 font-bold text-ink">
            {t('becomeTitle')}
          </h2>
          <p className="text-body-sm text-ink-soft">{t('becomeBody')}</p>
          {contactEmail && (
            <p className="text-body-sm">
              <a href={`mailto:${contactEmail}`} className="font-semibold text-link hover:text-link-hover">
                {contactEmail}
              </a>
            </p>
          )}
        </section>

        <p className="text-caption text-text-muted">{t('disclosure')}</p>
      </main>
    </AppShell>
  );
}
