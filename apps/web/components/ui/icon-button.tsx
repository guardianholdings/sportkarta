import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * IconButton — single-icon control for map controls, toolbars, compact actions
 * (seed contract: components/actions/IconButton). Always requires an aria-label.
 * md (44px) is the touch floor. `round` switches md-square → circle.
 */
const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-md transition-[background-color,color,box-shadow,transform] duration-150 ease-standard active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        surface:
          'bg-surface text-ink-soft border border-line-strong shadow-xs hover:bg-surface-2 hover:text-ink',
        solid: 'bg-brand text-on-brand shadow-xs hover:bg-brand-hover active:bg-brand-active',
        floating: 'bg-surface text-ink-soft shadow-float hover:bg-surface-2 hover:text-ink',
        ghost: 'bg-transparent text-ink-soft hover:bg-brand-subtle hover:text-brand',
      },
      size: { sm: 'size-9', md: 'size-11', lg: 'size-13' },
      round: { true: 'rounded-full', false: '' },
    },
    defaultVariants: { variant: 'surface', size: 'md', round: false },
  },
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  /** REQUIRED — the action name for assistive tech. */
  'aria-label': string;
}

export function IconButton({ className, variant, size, round, ...props }: IconButtonProps) {
  return (
    <button
      data-slot="icon-button"
      className={cn(iconButtonVariants({ variant, size, round }), className)}
      {...props}
    />
  );
}
