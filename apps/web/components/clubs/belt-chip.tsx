import type { BeltColour } from '@sportkarta/lib/clubs';

import { cn } from '@/lib/utils';

/**
 * A rank's belt (0056): its colour, an optional accent (a two-tone kids' belt,
 * a tip) and stripes (a BJJ belt's degrees, on a black bar — red on a black
 * belt). Colours are the --belt-* tokens; the swatch is decorative, so the
 * rank's NAME always stands beside it.
 */

/** Literal class names, so Tailwind sees every one. */
const FILL: Readonly<Record<BeltColour, string>> = {
  white: 'bg-belt-white',
  grey: 'bg-belt-grey',
  yellow: 'bg-belt-yellow',
  orange: 'bg-belt-orange',
  red: 'bg-belt-red',
  green: 'bg-belt-green',
  blue: 'bg-belt-blue',
  purple: 'bg-belt-purple',
  brown: 'bg-belt-brown',
  black: 'bg-belt-black',
};

export interface BeltLook {
  colour: BeltColour;
  accent: BeltColour | null;
  stripes: number;
}

export function BeltSwatch({ colour, accent, stripes }: BeltLook) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex h-3 w-10 shrink-0 overflow-hidden rounded-xs border border-line-strong',
        FILL[colour],
      )}
    >
      {accent && <span className={cn('absolute inset-y-0 right-0 w-1/3', FILL[accent])} />}
      {stripes > 0 && (
        <span
          className={cn(
            'absolute inset-y-0 right-1 flex w-3 items-stretch justify-center gap-px',
            colour === 'black' ? 'bg-belt-red' : 'bg-belt-black',
          )}
        >
          {Array.from({ length: stripes }, (_, index) => (
            <span key={index} className="w-px bg-belt-white" />
          ))}
        </span>
      )}
    </span>
  );
}

/** The swatch and the rank's name. */
export function BeltChip({
  name,
  colour,
  accent,
  stripes,
  className,
}: BeltLook & { name: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <BeltSwatch colour={colour} accent={accent} stripes={stripes} />
      <span className="min-w-0">{name}</span>
    </span>
  );
}
