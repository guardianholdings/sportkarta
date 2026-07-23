import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Stat — a labelled metric with the value in the mono/tabular face (seed
 * contract: components/data-display/Stat). The value ALWAYS renders in
 * JetBrains Mono (the data/label split is enforced here, not by convention —
 * RECONCILIATION.md C15). Pre-format the value (units, decimal comma for BG).
 */
const TONE = {
  default: 'text-ink',
  brand: 'text-brand',
  accent: 'text-accent-active',
} as const;

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The metric value — pre-formatted string/number (mono, tabular). */
  value: React.ReactNode;
  /** Caption under the value. */
  label: React.ReactNode;
  /** Optional leading icon (18px). */
  icon?: React.ReactNode;
  /** @default 'default' */
  tone?: keyof typeof TONE;
  /** @default 'left' */
  align?: 'left' | 'center';
}

export function Stat({
  className,
  value,
  label,
  icon,
  tone = 'default',
  align = 'left',
  ...props
}: StatProps) {
  return (
    <div
      data-slot="stat"
      className={cn('inline-flex flex-col gap-1', align === 'center' && 'items-center text-center', className)}
      {...props}
    >
      <span className={cn('inline-flex items-center gap-1.5 [&_svg]:shrink-0', TONE[tone])}>
        {icon}
        <span className="font-mono text-h3 font-semibold leading-none tabular-nums">{value}</span>
      </span>
      <span className="text-caption text-text-muted">{label}</span>
    </div>
  );
}
