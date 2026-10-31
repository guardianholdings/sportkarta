import { Check, MapPin, X } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { GuideCard } from './chapter';

/**
 * «Точки — само на място» as a drawing: the place, the 250-metre circle
 * (CONTRIBUTION_RADIUS_M and the check-in GEOFENCE_RADIUS_M), a member inside
 * it and one outside. The ring breathes unless the reader asked for stillness.
 */
export async function OnSite() {
  const t = await getTranslations('Home.guide.contribute.onsite');
  return (
    <GuideCard title={t('title')} icon={<MapPin size={18} aria-hidden="true" />}>
      <p className="text-body-sm text-ink-soft">{t('body')}</p>
      <svg viewBox="0 0 260 150" className="mt-4 w-full" aria-hidden="true">
        <defs>
          <pattern id="sk-onsite-dots" width="10" height="10" patternUnits="userSpaceOnUse">
            <circle cx="5" cy="5" r="1.1" className="text-line-strong" fill="currentColor" />
          </pattern>
        </defs>
        <rect width="260" height="150" rx="14" fill="url(#sk-onsite-dots)" />
        <circle
          cx="110"
          cy="78"
          r="56"
          className="text-brand"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="5 5"
        />
        <circle
          cx="110"
          cy="78"
          r="56"
          className="sk-onsite-ring text-brand"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <g className="text-accent" fill="currentColor">
          <path d="M110 54c-8 0-14 6-14 13 0 10 14 22 14 22s14-12 14-22c0-7-6-13-14-13z" />
          <circle cx="110" cy="67" r="5" className="text-paper" fill="currentColor" />
        </g>
        <g className="text-brand">
          <circle cx="146" cy="100" r="11" fill="currentColor" />
          <path
            d="M141 100l3.5 3.5 6.5-7"
            fill="none"
            className="text-paper"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g className="text-text-muted">
          <circle cx="226" cy="34" r="11" fill="currentColor" />
          <path
            d="M222 30l8 8m0-8l-8 8"
            className="text-paper"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </g>
        <path
          d="M110 78h56"
          className="text-brand-active"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 3"
        />
        <text
          x="150"
          y="72"
          textAnchor="middle"
          className="font-mono text-brand-active"
          fill="currentColor"
          fontSize="10"
          fontWeight="700"
        >
          {t('radius')}
        </text>
      </svg>
      <ul className="mt-3 flex flex-col gap-1.5 text-body-sm">
        <li className="flex items-center gap-2 text-ink">
          <Check size={16} aria-hidden="true" className="shrink-0 text-brand" />
          {t('near')}
        </li>
        <li className="flex items-center gap-2 text-ink-soft">
          <X size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
          {t('far')}
        </li>
      </ul>
      <p className="mt-3 text-caption text-text-muted">{t('privacy')}</p>
    </GuideCard>
  );
}
