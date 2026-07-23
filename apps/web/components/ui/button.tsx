import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Button — the primary action control (seed contract:
 * components/actions/Button.{d.ts,prompt.md}).
 *
 * Pill radius, Manrope 600, sentence-case verb-first labels. Sizes are the
 * seed's 36/44/52 (md = 44, the touch floor). Hover darkens one step (~150ms),
 * press is scale(0.97), focus ring is always visible (global :focus-visible;
 * accent switches it to the clay ring). `asChild` is retained beyond the seed
 * contract for text-link buttons that render an <a>/<Link>.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill font-semibold leading-none select-none transition-[background-color,color,box-shadow,transform] duration-150 ease-standard active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        primary: 'bg-brand text-on-brand shadow-xs hover:bg-brand-hover active:bg-brand-active',
        accent:
          'bg-accent text-on-accent shadow-xs hover:bg-accent-hover active:bg-accent-active focus-visible:shadow-[var(--ring-accent)]',
        secondary:
          'bg-surface text-text-primary border border-line-strong shadow-xs hover:bg-surface-2 active:bg-surface-2',
        ghost: 'bg-transparent text-brand hover:bg-brand-subtle active:bg-brand-subtle-hover',
        danger:
          'bg-danger text-on-brand shadow-xs hover:bg-[color-mix(in_oklab,var(--danger),black_12%)] active:bg-[color-mix(in_oklab,var(--danger),black_20%)]',
      },
      size: {
        sm: 'h-9 gap-1.5 px-4 text-body-sm',
        md: 'h-11 px-5 text-body-sm',
        lg: 'h-13 px-6 text-body',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Icon node before the label (20px Lucide line icon, currentColor). */
  iconLeft?: React.ReactNode;
  /** Icon node after the label. */
  iconRight?: React.ReactNode;
  /** Render as the single child element (for <a>/<Link> buttons). */
  asChild?: boolean;
}

function Button({
  className,
  variant,
  size,
  block,
  iconLeft,
  iconRight,
  asChild = false,
  children,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size, block }), className);

  // Slot needs a single child, so skip icon slots when composing (asChild).
  if (asChild) {
    return (
      <Slot data-slot="button" className={classes} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button data-slot="button" className={classes} {...props}>
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}

export { Button, buttonVariants };
