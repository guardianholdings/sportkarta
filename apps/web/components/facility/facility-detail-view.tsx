import { Navigation, ShieldCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Stat } from '@/components/ui/stat';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import { facilityFamily, FAMILY_COLOR } from '@/lib/design/families';
import { SPORT_VISUALS } from '@/lib/design/sport-visuals';
import type { CanonicalSport } from '@sportkarta/lib/sports';

/** The read-only public detail; the source of truth is lib/public-data. */
export interface FacilityDetailData {
  slug: string;
  name: string | null;
  sportTypes: string[];
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  access: string;
  source: string;
  quarter: string | null;
  municipalityName: string | null;
  lon: number;
  lat: number;
  lastVerifiedAt: string | null;
  condition: string | null;
  photos: string[];
}

// Facility photos live on the storage volume under this prefix.
const UPLOADS_PREFIX = '/uploads';

function primaryVisual(sports: string[]) {
  const s = sports.find((x): x is CanonicalSport => x in SPORT_VISUALS);
  if (s) return SPORT_VISUALS[s];
  return { color: FAMILY_COLOR[facilityFamily(sports)], Icon: SPORT_VISUALS.multi.Icon };
}

/**
 * Read-only facility detail — the seed spot-detail panel, rebuilt for our data.
 * Rendered by both /obekt/[slug] (server) and the map's in-sheet drill (client);
 * no server-only imports, and directions is a plain link so it needs no JS. The
 * hero is the no-photo fallback (category-tinted + sport glyph) until a photo is
 * approved — the common case at launch, designed as the default not the edge.
 */
export function FacilityDetailView({
  facility,
  showDirections = true,
}: {
  facility: FacilityDetailData;
  showDirections?: boolean;
}) {
  const t = useTranslations('Facility');
  const tSport = useTranslations('Sport');
  const tSurface = useTranslations('Surface');
  const tAccess = useTranslations('Access');
  const tSource = useTranslations('Source');
  const tCondition = useTranslations('Condition');
  const locale = useLocale();

  const name = facility.name ?? t('unnamed');
  const v = primaryVisual(facility.sportTypes);
  const area = [facility.quarter, facility.municipalityName].filter(Boolean).join(', ');
  const photo = facility.photos[0];

  const lighting =
    facility.lighting === null ? t('unknown') : facility.lighting ? t('yes') : t('no');
  const surface = facility.surface ? tSurface(facility.surface) : t('unknown');
  const lastVerified = facility.lastVerifiedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
        new Date(facility.lastVerifiedAt),
      )
    : null;
  const coords = `${facility.lat.toFixed(4)}, ${facility.lon.toFixed(4)}`;

  return (
    <article className="flex flex-col">
      {/* Hero — real photo or the category-tinted no-photo fallback */}
      <div className="relative flex h-48 items-center justify-center overflow-hidden">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${UPLOADS_PREFIX}/${photo}`}
            alt={t('photoAlt', { name })}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              background: `radial-gradient(circle at 50% 42%, color-mix(in srgb, ${v.color} 20%, var(--surface)), var(--surface) 74%)`,
              color: v.color,
            }}
          >
            <v.Icon size={72} className="opacity-25" />
          </div>
        )}
        {facility.sportTypes.length > 0 && (
          <span
            className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-pill bg-surface px-2.5 py-1 text-caption font-semibold shadow-sm"
            style={{ color: v.color }}
          >
            <span className="size-2 rounded-full" style={{ background: v.color }} />
            {tSport(facility.sportTypes[0] ?? '')}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-5 p-4 sm:p-5">
        <header>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{name}</h1>
          <p className="mt-1.5 font-mono text-caption text-text-muted">
            {area ? `${area} · ` : ''}
            {coords}
          </p>
        </header>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card bg-line sm:grid-cols-4">
          {[
            { value: tAccess(facility.access), label: t('access') },
            { value: surface, label: t('surface') },
            { value: lighting, label: t('lighting') },
            { value: facility.covered ? t('yes') : t('no'), label: t('covered') },
          ].map((s) => (
            <div key={s.label} className="bg-paper-sunk px-3 py-3">
              <Stat value={s.value} label={s.label} />
            </div>
          ))}
        </div>

        {/* Condition + verification — needs-verification is a data-quality signal,
            not a reason to hide the facility. */}
        <div className="flex flex-wrap items-center gap-2">
          {facility.condition ? (
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-brand-subtle px-2.5 py-1 text-caption font-medium text-brand">
              <ShieldCheck size={13} />
              {tCondition(facility.condition)}
            </span>
          ) : null}
          <span className="font-mono text-caption text-text-muted">
            {lastVerified ? t('lastVerified', { date: lastVerified }) : t('neverVerified')}
          </span>
        </div>

        {facility.sportTypes.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {facility.sportTypes.map((s) => {
              const sv = s in SPORT_VISUALS ? SPORT_VISUALS[s as CanonicalSport] : null;
              const color = sv?.color ?? FAMILY_COLOR.multi;
              const Icon = sv?.Icon ?? SPORT_VISUALS.multi.Icon;
              return (
                <span
                  key={s}
                  className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-caption font-medium"
                  style={{
                    background: `color-mix(in srgb, ${color} 12%, var(--surface))`,
                    color,
                  }}
                >
                  <Icon size={13} />
                  {tSport(s)}
                </span>
              );
            })}
          </div>
        )}

        <p className="text-caption text-text-muted">
          {t('dataSource')}: {tSource(facility.source)} · © OpenStreetMap
        </p>

        {showDirections && (
          <Button asChild>
            <a
              href={`https://www.openstreetmap.org/directions?to=${String(facility.lat)},${String(facility.lon)}`}
              target="_blank"
              rel="noopener noreferrer"
              // C1: the strongest "I am actually going" signal in the product,
              // on its highest-traffic page. Records THAT someone asked for
              // directions, never to which facility (lib/analytics-events.ts).
              data-umami-event={ANALYTICS_EVENTS.facilityDirections}
            >
              <Navigation size={19} />
              {t('directions')}
            </a>
          </Button>
        )}
      </div>
    </article>
  );
}
