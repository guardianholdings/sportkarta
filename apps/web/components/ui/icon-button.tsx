import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * IconButton — single-icon control for map controls, toolbars, compact actions
 * (seed contract: components/actions/IconButton). Always requires an aria-label.
 * md (44px) is the touch floor. `round` switches md-square → circle.
 */
// `focus-visible:shadow-[var(--ring)]` is NOT redundant with the global
// `:focus-visible { box-shadow: var(--ring) }` in globals.css. That rule lives
// in `@layer base`; every `shadow-*` utility below lives in `@layer utilities`
// and wins by layer order — so the base rule's `outline: none` still applied
// while its ring was discarded, leaving these controls with NO visible focus
// indicator at all. Verified in the browser: a focused primary button computed
// `outline: none` and a box-shadow containing only shadow-xs. The `accent`
// variant already carried its own focus shadow, which is why it was the only
// one that worked.
const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-md transition-[background-color,color,box-shadow,transform] duration-150 ease-standard focus-visible:shadow-[var(--ring)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
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
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof iconButtonVariants> {
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
