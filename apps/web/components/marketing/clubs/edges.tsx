import { BadgePercent, Database, EyeOff, FileInput, MapPinned, Medal } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';

const EDGES = [
  { key: 'found', icon: MapPinned },
  { key: 'passport', icon: Medal },
  { key: 'free', icon: Database },
  { key: 'fee', icon: BadgePercent },
  { key: 'privacy', icon: EyeOff },
  { key: 'migrate', icon: FileInput },
] as const;

/** «Само в POPS» — what no club software built for its own sake can offer. */
export async function Edges({ feeFree, paymentsOn }: { feeFree: boolean; paymentsOn: boolean }) {
  const t = await getTranslations('ClubsLanding.edges');
  const edges = EDGES.filter((edge) => edge.key !== 'fee' || (feeFree && paymentsOn));
  return (
    <section
      aria-labelledby="clubs-edges"
      className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20"
    >
      <SectionHead id="clubs-edges" overline={t('overline')} title={t('title')} lead={t('lead')} />
      <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {edges.map((edge) => (
          <li
            key={edge.key}
            className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5"
          >
            <span className="grid size-11 place-items-center rounded-full bg-accent-subtle text-accent-active">
              <edge.icon size={22} aria-hidden="true" />
            </span>
            <span className="text-body font-bold text-ink">{t(`${edge.key}.title`)}</span>
            <span className="text-body-sm text-ink-soft">{t(`${edge.key}.body`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
