'use client';

import { Tilt } from '@/components/motion/tilt';

export interface PassportCardCoin {
  src: string;
  name: string;
}

/**
 * A sample passport — the SHAPE of one, with example figures, so a visitor
 * sees what they would collect before signing in. Marked as a sample in
 * words; it is nobody's record. Leans towards the pointer (Tilt).
 */
export function PassportCard({
  labels,
  coins,
}: {
  labels: {
    sample: string;
    initials: string;
    name: string;
    city: string;
    points: string;
    streak: string;
    badges: string;
    note: string;
  };
  coins: PassportCardCoin[];
}) {
  return (
    <Tilt className="mx-auto w-full max-w-sm">
      <div className="sk-passport-card relative overflow-hidden rounded-card border border-line bg-surface p-5 shadow-lg">
        <span className="absolute right-4 top-4 rounded-pill bg-accent-subtle px-2.5 py-1 font-mono text-overline font-semibold uppercase tracking-wide text-accent-active">
          {labels.sample}
        </span>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-12 place-items-center rounded-full bg-brand-subtle font-display text-h4 font-extrabold text-brand"
          >
            {labels.initials}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-body font-bold text-ink">{labels.name}</span>
            <span className="block text-body-sm text-ink-soft">{labels.city}</span>
          </span>
        </div>
        <dl className="mt-5 grid grid-cols-3 gap-2">
          {[
            ['120', labels.points],
            ['4', labels.streak],
            ['5', labels.badges],
          ].map(([value, label]) => (
            <div key={label} className="flex flex-col gap-1 rounded-md bg-paper p-3">
              <dt className="order-2 text-caption text-ink-soft">{label}</dt>
              <dd className="order-1 font-mono text-h3 font-bold tabular-nums leading-none text-ink">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <ul className="mt-4 flex items-center gap-2" aria-label={labels.badges}>
          {coins.map((coin) => (
            <li key={coin.src}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the brand's own badge art */}
              <img src={coin.src} alt={coin.name} width={40} height={40} className="size-10" />
            </li>
          ))}
        </ul>
        <p className="mt-4 text-caption text-text-muted">{labels.note}</p>
      </div>
    </Tilt>
  );
}
