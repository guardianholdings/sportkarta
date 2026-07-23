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
      className={cn(
        'inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-pill border px-3.5 text-body-sm font-medium transition-[background-color,border-color,color,transform] duration-150 ease-standard active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
        selected
          ? 'border-[var(--chip)] bg-[color-mix(in_srgb,var(--chip)_14%,transparent)] text-[var(--chip)]'
          : 'border-line-strong bg-surface text-ink-soft hover:bg-surface-2',
        className,
      )}
      {...props}
    >
      <span className="flex text-[var(--chip)] [&_svg]:shrink-0">
        {icon ?? <span className="block size-2.5 rounded-full bg-current" />}
      </span>
      {children}
    </button>
  );
}
