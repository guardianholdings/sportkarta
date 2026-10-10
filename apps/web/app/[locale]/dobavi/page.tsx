import { getDb, sql } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireUser } from '@/lib/auth-session';
import { addedAway, addedBanner } from '@/lib/contributions/added-banner';
import { thanksMessage } from '@/lib/contributions/feedback';
import { Link } from '@/i18n/navigation';

import { AddFacilityForm } from './add-facility-form';
import { AppShell } from '@/components/shell/app-shell';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'AddFacility' });
  // A title of its own: it used to inherit the site's, so the tab, the history
  // and the screen reader's route announcement all said "the map".
  return { title: t('title'), robots: { index: false, follow: false } };
}

// Session-dependent and write-only: never prerender.
export const dynamic = 'force-dynamic';

/** Sofia centre — the starting view before the device offers its own position. */
const DEFAULT_CENTRE = { lon: 23.3219, lat: 42.6977 };

/** A coordinate from the query string, or null when it is absent or nonsense. */
function coordinate(value: string | string[] | undefined, limit: number): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) return null;
  return parsed;
}

export default async function AddFacilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Contributions require an account: an anonymous visitor is sent to sign in
  // and comes back here (the middleware carries the path through).
  await requireUser();
  const [t, tFacility, tContribute, paidSetting] = await Promise.all([
    getTranslations('AddFacility'),
    getTranslations('Facility'),
    getTranslations('Contribute'),
    getDb().execute(sql`SELECT value FROM app_settings WHERE key = 'public_show_paid'`),
  ]);
  const paidHidden = (paidSetting.rows[0] as { value?: string } | undefined)?.value !== 'true';

  // ?lon=&lat= starts the pin somewhere specific — used by "add a facility
  // here" links from the map, and then it already IS the member's choice. Only
  // the starting view: the value posted is whatever the pin ends up on, and the
  // server validates it.
  const sp = await searchParams;
  const fromLon = coordinate(sp.lon, 180);
  const fromLat = coordinate(sp.lat, 90);
  const initiallyPlaced = fromLon !== null && fromLat !== null;
  const lon = fromLon ?? DEFAULT_CENTRE.lon;
  const lat = fromLat ?? DEFAULT_CENTRE.lat;

  // A facility the public site does not show (paid, while paid venues are
  // hidden) has no page to land on, so its add is thanked here — see
  // lib/contributions/added-banner.ts `addedLanding`.
  const savedHidden = sp.saved === 'hidden';
  const thanks = savedHidden
    ? thanksMessage({ awarded: addedBanner(sp.added)?.points ?? 0, ...addedAway(sp.away) })
    : null;

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl px-4 py-5">
        <Link
          href="/"
          className="mb-4 inline-flex min-h-11 items-center text-body-sm font-medium text-ink-soft hover:text-brand"
        >
          {tFacility('backToMap')}
        </Link>
        {thanks && (
          <div
            role="status"
            className="mb-5 rounded-card border border-accent-border bg-accent-subtle p-4"
          >
            <p className="text-h4 font-bold text-accent-active">
              {thanks.key === 'thanksWithPoints'
                ? tContribute('thanksWithPoints', { points: thanks.points })
                : thanks.key === 'offSiteNotice'
                  ? tContribute('offSiteNotice', { km: thanks.km })
                  : tContribute(thanks.key)}
            </p>
            <p className="mt-1 text-body-sm text-ink-soft">{t('savedHiddenBody')}</p>
          </div>
        )}
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">
          {thanks ? t('addAnother') : t('title')}
        </h1>
        <p className="mt-1.5 text-body-sm text-ink-soft">{t('intro')}</p>
        <div className="mt-5 rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5">
          <AddFacilityForm
            initialLon={lon}
            initialLat={lat}
            initiallyPlaced={initiallyPlaced}
            paidHidden={paidHidden}
          />
        </div>
      </main>
    </AppShell>
  );
}
