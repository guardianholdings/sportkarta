import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Badge — small non-interactive status/label pill (seed contract:
 * components/data-display/Badge). For clickable filters use Chip. Difficulty,
 * open/closed, "new", ranks. Pill radius, sans label, 13px icon slot.
 */
export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';
export type BadgeVariant = 'soft' | 'solid' | 'outline';

// tone × variant. Kept as a lookup (not 21 cva compounds) so the matrix reads
// at a glance and every colour is a token utility.
const TONE: Record<BadgeTone, Record<BadgeVariant, string>> = {
  neutral: {
    soft: 'bg-surface-2 text-ink-soft',
    solid: 'bg-ink text-on-brand',
    outline: 'border border-line-strong text-ink-soft',
  },
  brand: {
    soft: 'bg-brand-subtle text-brand',
    solid: 'bg-brand text-on-brand',
    outline: 'border border-brand-border text-brand',
  },
  accent: {
    soft: 'bg-accent-subtle text-accent-active',
    solid: 'bg-accent text-on-accent',
    outline: 'border border-accent-border text-accent-active',
  },
  success: {
    soft: 'bg-success-bg text-success',
    solid: 'bg-success text-on-brand',
    outline: 'border border-success-border text-success',
  },
  warning: {
    soft: 'bg-warning-bg text-warning',
    solid: 'bg-warning text-on-brand',
    outline: 'border border-warning-border text-warning',
  },
  danger: {
    soft: 'bg-danger-bg text-danger',
    solid: 'bg-danger text-on-brand',
    outline: 'border border-danger-border text-danger',
  },
  info: {
    soft: 'bg-info-bg text-info',
    solid: 'bg-info text-on-brand',
    outline: 'border border-info-border text-info',
  },
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** @default 'neutral' */
  tone?: BadgeTone;
  /** @default 'soft' */
  variant?: BadgeVariant;
  /** Optional leading icon (13px). */
  icon?: React.ReactNode;
}

export function Badge({
  className,
  tone = 'neutral',
  variant = 'soft',
  icon,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-pill px-2.5 py-0.5 text-caption font-medium leading-normal [&_svg]:shrink-0',
        TONE[tone][variant],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}
