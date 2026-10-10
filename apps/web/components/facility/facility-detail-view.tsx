import { CircleDashed, Navigation, ShieldCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { facilityTitle } from '@/components/map/facility-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Stat } from '@/components/ui/stat';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import { facilityFamily, FAMILY_COLOR } from '@/lib/design/families';
import { SPORT_VISUALS } from '@/lib/design/sport-visuals';
import { NAV_PROVIDERS } from '@/lib/directions';
import { formatDate } from '@/lib/format';
import { placeLabel } from '@/lib/geo';
import { photoUrl } from '@/lib/photo-url';
import type { CanonicalSport } from '@sportkarta/lib/sports';

/**
 * An activity hue as TEXT. The raw hues are graphics colours: as 13px labels on
 * the surface they measured 2.6–4.5:1 (bike, calisthenics, swimming, running,
 * rackets all under AA), and the Chip primitive darkens its label by the same
 * 35% for the same reason (components/ui/chip.tsx). The dot, the icon and the
 * tint keep the raw colour.
 */
function readableOn(color: string): string {
  return `color-mix(in oklab, ${color}, black 35%)`;
}

/** The read-only public detail; the source of truth is lib/public-data. */
export interface FacilityDetailData {
  slug: string;
  name: string | null;
  sportTypes: string[];
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  /** False when `covered` is only the column default — rendered as "unknown". */
  coveredKnown: boolean;
  access: string;
  /** `needs_verification` shows the "awaiting verification" badge. */
  status: string;
  source: string;
  quarter: string | null;
  municipalityName: string | null;
  lon: number;
  lat: number;
  lastVerifiedAt: string | null;
  condition: string | null;
  /** Approved photo ids (lib/public-data.ts), rendered through lib/photo-url.ts. */
  photoIds: string[];
}

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

  const area = placeLabel(facility.quarter, facility.municipalityName);
  // The same name the map list and the place pages give it (facility-label.ts):
  // «Баскетбол — София» for an unnamed facility, rather than the generic noun
  // the list never shows — tapping «Фитнес — София» used to open a page called
  // «Спортно съоръжение» (UX audit 2026-10-10).
  const name = facilityTitle(
    { name: facility.name, sports: facility.sportTypes, place: area },
    {
      locale,
      unnamed: t('unnamed'),
      sport: (sport) => tSport(sport),
      unnamedAt: (what, place) => t('unnamedAt', { what, place }),
    },
  );
  const named = Boolean(facility.name?.trim());
  const v = primaryVisual(facility.sportTypes);
  const photo = facility.photoIds[0];

  const lighting =
    facility.lighting === null ? t('unknown') : facility.lighting ? t('yes') : t('no');
  // Same tri-state as lighting: a `false` nobody asserted is "unknown", never
  // "no" — an indoor hall imported without a roof tag is not open-air.
  const covered = !facility.coveredKnown ? t('unknown') : facility.covered ? t('yes') : t('no');
  const surface = facility.surface ? tSurface(facility.surface) : t('unknown');
  // Sofia's calendar day, not the server's UTC one (lib/format.ts).
  const lastVerified = facility.lastVerifiedAt ? formatDate(facility.lastVerifiedAt, locale) : null;
  const awaiting = facility.status === 'needs_verification';
  const coords = `${facility.lat.toFixed(4)}, ${facility.lon.toFixed(4)}`;

  return (
    <article className="flex flex-col">
      {/* Hero — real photo or the category-tinted no-photo fallback */}
      <div className="relative flex h-48 items-center justify-center overflow-hidden">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl(photo)}
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
            style={{ color: readableOn(v.color) }}
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
            {/* An unnamed facility already carries its place in the heading. */}
            {named && area ? `${area} · ` : ''}
            {coords}
          </p>
        </header>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card bg-line sm:grid-cols-4">
          {[
            { value: tAccess(facility.access), label: t('access') },
            { value: surface, label: t('surface') },
            { value: lighting, label: t('lighting') },
            { value: covered, label: t('covered') },
          ].map((s) => (
            <div key={s.label} className="bg-paper-sunk px-3 py-3">
              <Stat value={s.value} label={s.label} />
            </div>
          ))}
        </div>

        {/* Condition + verification — needs-verification is a data-quality signal,
            not a reason to hide the facility, so it is SAID rather than hidden. */}
        <div className="flex flex-wrap items-center gap-2">
          {awaiting ? (
            <Badge tone="warning" icon={<CircleDashed size={13} />}>
              {t('awaitingVerification')}
            </Badge>
          ) : null}
          {facility.condition ? (
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-brand-subtle px-2.5 py-1 text-caption font-medium text-brand">
              <ShieldCheck size={13} />
              {tCondition(facility.condition)}
            </span>
          ) : null}
          {/* «Очаква проверка» already says it was never checked; the line
              only adds news when there IS a date, or for an active record. */}
          {(lastVerified || !awaiting) && (
            <span className="font-mono text-caption text-text-muted">
              {lastVerified ? t('lastVerified', { date: lastVerified }) : t('neverVerified')}
            </span>
          )}
        </div>

        {/* With one sport the hero pill already names it; the row is for the
            facilities that have more than one. */}
        {facility.sportTypes.length > 1 && (
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
                    color: readableOn(color),
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
          {/* An OSM record is attributed once, not «OpenStreetMap · © OpenStreetMap». */}
          {t('dataSource')}:{' '}
          {facility.source === 'osm'
            ? '© OpenStreetMap'
            : `${tSource(facility.source)} · © OpenStreetMap`}
        </p>

        {showDirections && (
          <div className="flex flex-col gap-2">
            <p className="text-caption text-text-muted">
              <Navigation size={15} className="mr-1 inline align-[-2px]" />
              {t('directions')}
            </p>
            <div className="flex flex-wrap gap-2">
              {NAV_PROVIDERS.map((provider) => (
                <Button key={provider.id} asChild>
                  <a
                    href={provider.href(facility.lat, facility.lon)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('directionsWith', { app: provider.brand })}
                    // C1: the strongest "I am actually going" signal in the
                    // product, on its highest-traffic page. Records THAT
                    // someone asked for directions, never to which facility
                    // and never which app (lib/analytics-events.ts).
                    data-umami-event={ANALYTICS_EVENTS.facilityDirections}
                  >
                    {provider.brand}
                  </a>
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
