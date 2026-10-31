import { ArrowUp, Camera, EyeOff, Layers, Scale, ShieldCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { GuideCard } from './chapter';

/** A flat plane seen from above at an angle — one source of the map's data. */
function Plane({ y, tone, dots }: { y: number; tone: string; dots: [number, number][] }) {
  return (
    <g className={tone}>
      <path
        d={`M100 ${y - 26}L172 ${y}L100 ${y + 26}L28 ${y}Z`}
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {dots.map(([dx, dy]) => (
        <circle key={`${dx}:${dy}`} cx={100 + dx} cy={y + dy} r="3" fill="currentColor" />
      ))}
    </g>
  );
}

/**
 * «Чия поправка печели» — the merge policy (lib/src/merge-policy.ts) as three
 * stacked planes: OpenStreetMap underneath, the municipal registers over it,
 * people on site on top. A field set by a person is never overwritten by an
 * import; a register corrects stale OSM data.
 */
export async function DataLayers() {
  const t = await getTranslations('Home.guide.contribute.layers');
  const layers = [
    { key: 'people', chip: 'bg-accent' },
    { key: 'municipal', chip: 'bg-sky-500' },
    { key: 'osm', chip: 'bg-brand' },
  ] as const;
  return (
    <GuideCard title={t('title')} icon={<Layers size={18} aria-hidden="true" />}>
      <p className="text-body-sm text-ink-soft">{t('body')}</p>
      <div className="mt-4 grid items-center gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <svg viewBox="0 0 200 170" className="mx-auto w-full max-w-56" aria-hidden="true">
          <Plane
            y={132}
            tone="text-brand"
            dots={[
              [-40, 0],
              [-20, -8],
              [-20, 8],
              [0, -16],
              [0, 0],
              [0, 16],
              [20, -8],
              [20, 8],
              [40, 0],
            ]}
          />
          <Plane
            y={87}
            tone="text-sky-500"
            dots={[
              [-24, 0],
              [8, -10],
              [24, 6],
            ]}
          />
          <Plane
            y={42}
            tone="text-accent"
            dots={[
              [-10, 4],
              [18, -4],
            ]}
          />
          <path
            d="M186 128V34"
            className="text-ink-soft"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="3 4"
          />
          <path
            d="M180 42l6-9 6 9"
            className="text-ink-soft"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
        <ol className="flex flex-col gap-3">
          {layers.map(({ key, chip }) => (
            <li key={key} className="flex gap-2.5">
              <span
                aria-hidden="true"
                className={`mt-1.5 size-2.5 shrink-0 rounded-full ${chip}`}
              />
              <span className="min-w-0 text-body-sm">
                <span className="block font-bold text-ink">{t(`${key}.title`)}</span>
                <span className="block text-ink-soft">{t(`${key}.body`)}</span>
              </span>
            </li>
          ))}
          <li className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-text-muted">
            <ArrowUp size={14} aria-hidden="true" />
            {t('strongest')}
          </li>
        </ol>
      </div>
    </GuideCard>
  );
}

/** The four rules a photo and a contribution live under. */
export async function PhotoRules() {
  const t = await getTranslations('Home.guide.contribute.rules');
  const rules = [
    { key: 'people', icon: EyeOff },
    { key: 'metadata', icon: ShieldCheck },
    { key: 'review', icon: Camera },
    { key: 'license', icon: Scale },
  ] as const;
  return (
    <GuideCard title={t('title')} icon={<Camera size={18} aria-hidden="true" />}>
      <ul className="flex flex-col gap-3">
        {rules.map(({ key, icon: Icon }) => (
          <li key={key} className="flex gap-2.5 text-body-sm text-ink-soft">
            <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-brand" />
            {t(key)}
          </li>
        ))}
      </ul>
    </GuideCard>
  );
}
