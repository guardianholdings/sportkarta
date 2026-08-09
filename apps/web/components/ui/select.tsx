import { cva, type VariantProps } from 'class-variance-authority';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Select — native <select> styled to match Input, with a custom chevron
 * (seed contract: components/forms/Select). Native for accessibility + mobile
 * pickers. Radius md.
 */
const selectVariants = cva(
  'w-full appearance-none rounded-input bg-surface text-ink border border-line-strong pl-3.5 pr-10 transition-[border-color,box-shadow] duration-150 ease-standard focus-visible:border-brand disabled:opacity-50 disabled:pointer-events-none',
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

export interface SelectProps
  extends
    Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'>,
    VariantProps<typeof selectVariants> {
  children?: React.ReactNode;
}

export function Select({ className, size, invalid, children, ...props }: SelectProps) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        data-slot="select"
        className={cn(selectVariants({ size, invalid }), className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={18}
        className="pointer-events-none absolute right-3 text-text-muted"
        aria-hidden="true"
      />
    </span>
  );
}
