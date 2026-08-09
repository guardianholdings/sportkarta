import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Input — single-line text field; base for search (pass a Search icon as
 * iconLeft). Seed contract: components/forms/Input. Radius md; focus draws the
 * global pine ring; `invalid` shows the rust border.
 */
const inputVariants = cva(
  'w-full rounded-input bg-surface text-ink border border-line-strong placeholder:text-text-muted transition-[border-color,box-shadow] duration-150 ease-standard focus-visible:border-brand disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      size: {
        sm: 'h-9 text-body-sm',
        md: 'h-11 text-body',
        lg: 'h-13 text-body-lg',
      },
      invalid: { true: 'border-danger focus-visible:border-danger', false: '' },
    },
    defaultVariants: { size: 'md', invalid: false },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {
  /** Leading icon (18px, currentColor) — pass a Search icon for search fields. */
  iconLeft?: React.ReactNode;
  /** Trailing icon (18px). */
  iconRight?: React.ReactNode;
}

export function Input({ className, size, invalid, iconLeft, iconRight, ...props }: InputProps) {
  const padded = cn(
    inputVariants({ size, invalid }),
    iconLeft ? 'pl-10' : 'pl-3.5',
    iconRight ? 'pr-10' : 'pr-3.5',
    className,
  );

  if (!iconLeft && !iconRight) {
    return <input data-slot="input" className={padded} {...props} />;
  }

  return (
    <span className="relative inline-flex w-full items-center">
      {iconLeft ? (
        <span className="pointer-events-none absolute left-3 flex text-text-muted">{iconLeft}</span>
      ) : null}
      <input data-slot="input" className={padded} {...props} />
      {iconRight ? (
        <span className="pointer-events-none absolute right-3 flex text-text-muted">
          {iconRight}
        </span>
      ) : null}
    </span>
  );
}
