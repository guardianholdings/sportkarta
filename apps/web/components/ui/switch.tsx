import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Switch — instant on/off toggle for settings (map layers, notifications).
 * Seed contract: components/forms/Switch. Pill track, pine when on. For form
 * submission choices use Checkbox instead.
 *
 * The thumb sits inside the track (the peer's sibling), so the slide is driven
 * by a child-variant on the track (`peer-checked:[&>span]:translate-x-*`).
 */
const trackVariants = cva(
  'relative inline-block shrink-0 rounded-pill bg-line-strong transition-colors duration-150 ease-standard peer-checked:bg-brand peer-focus-visible:shadow-[var(--ring)]',
  {
    variants: {
      size: {
        sm: 'h-5 w-9 peer-checked:[&>span]:translate-x-4',
        md: 'h-6 w-11 peer-checked:[&>span]:translate-x-5',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

const thumbVariants = cva(
  'absolute left-0.5 top-0.5 rounded-full bg-surface shadow-xs transition-transform duration-150 ease-standard',
  {
    variants: { size: { sm: 'size-4', md: 'size-5' } },
    defaultVariants: { size: 'md' },
  },
);

export interface SwitchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'>,
    VariantProps<typeof trackVariants> {
  label?: React.ReactNode;
}

export function Switch({ className, size, label, ...props }: SwitchProps) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer select-none items-center gap-2.5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
        className,
      )}
    >
      <input type="checkbox" role="switch" className="peer sr-only" {...props} />
      <span className={trackVariants({ size })}>
        <span className={thumbVariants({ size })} />
      </span>
      {label ? <span className="text-body-sm text-ink">{label}</span> : null}
    </label>
  );
}
