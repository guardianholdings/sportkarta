import { getDb } from '@sportkarta/db';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { requireRole } from '@/lib/auth-session';
import { listPartners } from '@/lib/partners';
import { Link } from '@/i18n/navigation';

import { setVisibleAction } from './actions';

/**
 * Partner registry list (docs/MONETISATION.md M1). Admin-only — who the NGO
 * partners with is not a moderation decision. The "изтича скоро" indicator is
 * the renewal tickler from the plan: a headline logo must never silently
 * vanish mid-negotiation.
 */
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

const EXPIRY_SOON_DAYS = 60;

type PageParams = Promise<{ locale: string }>;

export default async function AdminPartnersPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const [t, partners] = await Promise.all([
    getTranslations('AdminPartners'),
    listPartners(getDb()),
  ]);

  const soon = new Date(Date.now() + EXPIRY_SOON_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  return (
    <main className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-h3 font-bold text-ink">{t('title')}</h1>
        <Link
          href="/admin/partnyori/nova"
          className="rounded-md bg-brand px-4 py-2 text-body-sm font-semibold text-on-brand"
        >
          {t('newPartner')}
        </Link>
      </header>

      {partners.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-6 py-10 text-center text-body-sm text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b border-line text-left text-caption text-text-muted">
                <th className="py-2 pr-3">{t('colName')}</th>
                <th className="py-2 pr-3">{t('colTier')}</th>
                <th className="py-2 pr-3">{t('colWindow')}</th>
                <th className="py-2 pr-3">{t('colVisible')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.id} className="border-b border-line">
                  <td className="py-2 pr-3">
                    <Link
                      href={`/admin/partnyori/${p.slug}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {p.nameBg}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">{t(`tier_${p.tier}`)}</td>
                  <td className="py-2 pr-3 font-mono text-caption tabular-nums">
                    {p.startsOn ?? '—'} → {p.endsOn ?? '—'}
                    {p.endsOn && p.endsOn <= soon && (
                      <Badge tone="warning" variant="soft" className="ml-2">
                        {t('expiresSoon')}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {p.visible ? (
                      <Badge tone="success" variant="soft">
                        {t('visibleYes')}
                      </Badge>
                    ) : (
                      <Badge tone="neutral" variant="soft">
                        {t('visibleNo')}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <form action={setVisibleAction.bind(null, p.slug, !p.visible)}>
                      <button
                        type="submit"
                        className="rounded-pill border border-line-strong bg-surface px-3 py-1 text-caption font-semibold text-ink-soft hover:bg-surface-2"
                      >
                        {p.visible ? t('hide') : t('publish')}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
