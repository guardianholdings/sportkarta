import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { clubSportLabeler, clubSportOptions } from '@/lib/clubs/labels';
import { clubMunicipalities, publicClubDirectory } from '@/lib/clubs/public';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';
import { buildAlternates } from '@/lib/seo';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubPublic' });
  return {
    title: t('directoryTitle'),
    description: t('directoryMeta'),
    alternates: buildAlternates('/klubove', locale),
  };
}

/**
 * The directory of clubs (/klubove): only RENDERABLE clubs (public.ts), in
 * name order — a paid tier buys tools, never a higher place in this list.
 * Filters are plain GET parameters, so the page works without JavaScript and
 * a filtered view is a shareable link.
 */
export default async function ClubDirectoryPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ sport?: string; grad?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const query = await searchParams;
  const [t, tClub, sportLabel, sportOptions, catalog, withClubs] = await Promise.all([
    getTranslations('ClubPublic'),
    getTranslations('Club'),
    clubSportLabeler(),
    clubSportOptions(locale),
    loadCityCatalog(),
    clubMunicipalities(),
  ]);
  const city = query.grad ? (catalog.bySlug.get(query.grad) ?? null) : null;
  const sport = sportOptions.some((option) => option.value === query.sport)
    ? (query.sport ?? null)
    : null;
  const clubs = await publicClubDirectory(locale, {
    municipalityId: city?.id ?? null,
    sport,
  });
  const cities = withClubs
    .map((id) => catalog.byId.get(id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map((c) => ({ slug: c.slug, name: cityDisplayName(c.nameBg, c.nameEn, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const cityName = (id: number | null) => {
    const found = id === null ? undefined : catalog.byId.get(id);
    return found ? cityDisplayName(found.nameBg, found.nameEn, locale) : null;
  };

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-4xl space-y-6 p-4">
        <header className="space-y-2 border-b border-line pb-3">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('directoryTitle')}</h1>
          <p className="max-w-prose text-body-sm text-ink-soft">{t('directoryIntro')}</p>
        </header>

        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-caption text-ink-soft">
            {t('filterSport')}
            <Select name="sport" defaultValue={sport ?? ''} size="sm">
              <option value="">{t('filterAll')}</option>
              {sportOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          {cities.length > 0 && (
            <label className="text-caption text-ink-soft">
              {t('filterCity')}
              <Select name="grad" defaultValue={city?.slug ?? ''} size="sm">
                <option value="">{t('filterAll')}</option>
                {cities.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <Button type="submit" variant="secondary" size="sm">
            {t('filter')}
          </Button>
        </form>

        {clubs.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
            {t('empty')}
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {clubs.map((club) => (
              <li key={club.id}>
                <Link
                  href={`/klub/${club.slug}`}
                  className="flex h-full gap-3 rounded-card border border-line bg-surface p-4 shadow-sm transition-colors hover:border-brand focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                >
                  {club.hasLogo && (
                    // eslint-disable-next-line @next/next/no-img-element -- the row-decides logo route
                    <img
                      src={`/api/clubs/logo/${club.id}`}
                      alt=""
                      width={48}
                      height={48}
                      className="size-12 shrink-0 rounded-xs object-contain"
                    />
                  )}
                  <span className="min-w-0 space-y-1">
                    <span className="block text-body font-bold text-ink">{club.name}</span>
                    <span className="flex flex-wrap gap-1.5">
                      <Badge tone="neutral">{tClub(`kind.${club.kind}`)}</Badge>
                      {cityName(club.municipalityId) && (
                        <Badge tone="info">{cityName(club.municipalityId)}</Badge>
                      )}
                    </span>
                    {club.sports.length > 0 && (
                      <span className="block text-caption text-text-muted">
                        {club.sports.slice(0, 5).map(sportLabel).join(' · ')}
                      </span>
                    )}
                    <span className="block text-caption text-ink-soft">
                      {t('classesThisWeek', { count: club.classesThisWeek })}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <section className="space-y-2 rounded-card border border-dashed border-line-strong p-4">
          <h2 className="text-body font-bold text-ink">{t('applyTitle')}</h2>
          <p className="max-w-prose text-body-sm text-ink-soft">{t('applyBody')}</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/klubove/zayavka" className={buttonVariants({ variant: 'secondary' })}>
              {t('apply')}
            </Link>
            <Link href="/za-klubove" className={buttonVariants({ variant: 'ghost' })}>
              {t('applyMore')}
            </Link>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
