'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';

export interface Coin {
  slug: string;
  art: string;
  name: string;
  description: string;
}

/**
 * The fourteen badge coins as a showcase: pick one and it spins, and the line
 * under the row says what it is and how it is earned. The coins show their
 * EARNED face — this is the catalogue, not anybody's progress; a member's own
 * locked/earned state lives on /pasport, where the brand rule (locked until
 * complete) applies.
 */
export function BadgeCoins({
  coins,
  flipLabel,
  columns = 'grid-cols-5 sm:grid-cols-7',
}: {
  coins: Coin[];
  flipLabel: string;
  /** The grid's column classes, for a row sized to its own group. */
  columns?: string;
}) {
  const [selected, setSelected] = useState(coins[0]?.slug ?? null);
  const current = coins.find((coin) => coin.slug === selected) ?? coins[0];

  return (
    <div>
      <ul className={cn('grid gap-2 sm:gap-3', columns)}>
        {coins.map((coin) => (
          <li key={coin.slug}>
            <button
              type="button"
              aria-pressed={coin.slug === selected}
              aria-label={flipLabel.replace('{name}', coin.name)}
              onClick={() => setSelected(coin.slug)}
              className={cn(
                'sk-coin block w-full rounded-full focus-visible:shadow-[var(--ring)]',
                coin.slug === selected && 'is-selected',
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a static brand SVG */}
              <img src={coin.art} alt="" width={96} height={96} className="aspect-square w-full" />
            </button>
          </li>
        ))}
      </ul>
      {current && (
        <p aria-live="polite" className="mt-4 min-h-12 text-body-sm text-ink-soft">
          <span className="font-display font-bold text-ink">{current.name}</span>
          <span aria-hidden="true"> — </span>
          {current.description}
        </p>
      )}
    </div>
  );
}
