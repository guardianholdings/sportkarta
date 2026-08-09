import { getDb, sql } from '@sportkarta/db';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requireRole } from '@/lib/auth-session';

import { setBusinessVisibleAction, setShowPaidAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Private-venues control room (0018). One MASTER switch decides whether the
 * commercial (access='paid') category is public at all; beneath it, one row
 * per BUSINESS — a chain with thirty locations is one decision. Everything
 * downstream (map, API, SEO, open-data dumps, stats views) reads the same
 * predicate, so "hidden" here means hidden everywhere.
 */

interface BusinessRow {
  id: number;
  name: string;
  visible: boolean;
  spots: number;
}

export default async function AdminPrivatePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');
  const t = await getTranslations('AdminPrivate');

  const db = getDb();
  const [settingResult, businessResult] = await Promise.all([
    db.execute(sql`SELECT value FROM app_settings WHERE key = 'public_show_paid'`),
    db.execute(sql`
      SELECT b.id, b.name, b.visible, count(f.id)::int AS spots
      FROM businesses b
      LEFT JOIN facilities f ON f.business_id = b.id
      GROUP BY b.id, b.name, b.visible
      ORDER BY b.name
    `),
  ]);
  const masterOn = (settingResult.rows[0] as { value?: string } | undefined)?.value === 'true';
  const businesses = businessResult.rows as unknown as BusinessRow[];

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      <section className="flex flex-wrap items-center gap-4 rounded-card border border-line bg-surface p-4 shadow-sm">
        <div className="min-w-0 flex-1">
          <h2 className="t-overline">{t('masterLabel')}</h2>
          <p className="mt-1.5 flex items-center gap-2 text-body-sm">
            <Badge tone={masterOn ? 'success' : 'neutral'}>
              {masterOn ? t('masterOn') : t('masterOff')}
            </Badge>
            <span className="text-caption text-text-muted">{t('refreshNote')}</span>
          </p>
        </div>
        <form action={setShowPaidAction}>
          <input type="hidden" name="value" value={masterOn ? 'false' : 'true'} />
          <Button type="submit" variant={masterOn ? 'secondary' : 'primary'}>
            {masterOn ? t('disable') : t('enable')}
          </Button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-h4 font-bold text-ink">{t('businessesTitle')}</h2>
        {businesses.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
            {t('empty')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="border-b border-line bg-paper-sunk text-left">
                  <th scope="col" className="t-overline px-3 py-2.5 font-semibold">
                    {t('colBusiness')}
                  </th>
                  <th scope="col" className="t-overline px-3 py-2.5 text-right font-semibold">
                    {t('colSpots')}
                  </th>
                  <th scope="col" className="t-overline px-3 py-2.5 font-semibold">
                    {t('colStatus')}
                  </th>
                  <th scope="col" className="t-overline px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {businesses.map((business) => (
                  <tr key={business.id}>
                    <td className="px-3 py-2.5 font-medium text-ink">{business.name}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      {business.spots}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={business.visible ? 'success' : 'neutral'}>
                        {business.visible ? t('visible') : t('hidden')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <form action={setBusinessVisibleAction}>
                        <input type="hidden" name="id" value={business.id} />
                        <input
                          type="hidden"
                          name="visible"
                          value={business.visible ? 'false' : 'true'}
                        />
                        <Button type="submit" variant="secondary" size="sm">
                          {business.visible ? t('hide') : t('show')}
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
