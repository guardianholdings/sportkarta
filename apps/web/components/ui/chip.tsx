import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Chip — interactive selectable pill for filters and activity categories (seed
 * contract: components/data-display/Chip). Pass the category colour; `selected`
 * fills with a 14% tint and colours the border/text, unselected shows a colour
 * dot (or your icon). Static labels → Badge.
 *
 * 36px tall — the seed specifies sub-44px filter chips deliberately
 * (RECONCILIATION.md, seed §3.3); the ≥44px floor governs primary controls.
 */
export interface ChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** Selected/active state. */
  selected?: boolean;
  /** Category/accent colour (e.g. var(--cat-bike)). @default var(--brand) */
  color?: string;
  /** Optional icon; when omitted a colour dot is shown. */
  icon?: React.ReactNode;
}

/**
 * The chip's look, on its own.
 *
 * Some filters navigate rather than toggle — the leaderboard's scope/sport/period
 * filters are `<Link>`s so the board stays server-rendered and shareable — and
 * before this existed those screens hand-rolled their own pill. They drifted:
 * /klasirane drew its SELECTED state at `rounded-pill text-caption` and its
 * unselected state at `rounded text-xs`, so one control changed radius and font
 * size depending on whether it was on. One definition, two hosts.
 *
 * Callers that render a link must set `--chip` themselves (or accept the brand
 * default) via the returned classes plus a style prop, exactly as `Chip` does.
 */
export function chipClass({
  selected = false,
  className,
}: { selected?: boolean; className?: string } = {}): string {
  return cn(
    'inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-pill border px-3.5 text-body-sm font-medium transition-[background-color,border-color,color,transform] duration-150 ease-standard focus-visible:shadow-[var(--ring)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
    selected
      ? // The BORDER and FILL keep the raw activity hue — that is the colour
        // coding, and it must stay recognisable against the map's markers. The
        // LABEL does not: the raw hue on its own 14% tint measured 2.20:1
        // (bike), 2.66 (calisthenics), 2.88 (swim) … 4.16 (team) — every one of
        // the ten categories below AA, on the map's sport filters, /dobavi's
        // picker and the leaderboard's scope pills. Darkening only the text by
        // 35% lifts all of them to 4.71–8.81 while leaving the colour identity
        // untouched. Same idiom Button's danger variant already uses.
        'border-[var(--chip,var(--brand))] bg-[color-mix(in_srgb,var(--chip,var(--brand))_14%,transparent)] text-[color-mix(in_oklab,var(--chip,var(--brand)),black_35%)]'
      : 'border-line-strong bg-surface text-ink-soft hover:bg-surface-2',
    className,
  );
}

export function Chip({
  className,
  selected = false,
  color = 'var(--brand)',
  icon,
  children,
  ...props
}: ChipProps) {
  return (
    <button
      type="button"
      data-slot="chip"
      aria-pressed={selected}
      style={{ '--chip': color } as React.CSSProperties}
      className={chipClass({ selected, className })}
      {...props}
    >
      <span className="flex text-[var(--chip,var(--brand))] [&_svg]:shrink-0">
        {icon ?? <span className="block size-2.5 rounded-full bg-current" />}
      </span>
      {children}
    </button>
  );
}
