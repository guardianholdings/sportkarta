import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireUser } from '@/lib/auth-session';

import { AddFacilityForm } from './add-facility-form';

export const metadata = { robots: { index: false, follow: false } };

// Session-dependent and write-only: never prerender.
export const dynamic = 'force-dynamic';

/** Sofia centre — the starting view before the device offers its own position. */
const DEFAULT_CENTRE = { lon: 23.3219, lat: 42.6977 };

/** A coordinate from the query string, or null when it is absent or nonsense. */
function coordinate(value: string | string[] | undefined, limit: number): number | null {
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
  const t = await getTranslations('AddFacility');

  // ?lon=&lat= starts the pin somewhere specific — used by "add a facility
  // here" links from the map. Only the starting view; the value posted is
  // whatever the member ends up dragging to, and the server validates it.
  const sp = await searchParams;
  const lon = coordinate(sp.lon, 180) ?? DEFAULT_CENTRE.lon;
  const lat = coordinate(sp.lat, 90) ?? DEFAULT_CENTRE.lat;

  return (
    <main className="mx-auto max-w-xl space-y-6 p-4">
      <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
      <p className="text-sm text-neutral-600">{t('intro')}</p>
      <AddFacilityForm initialLon={lon} initialLat={lat} />
    </main>
  );
}
