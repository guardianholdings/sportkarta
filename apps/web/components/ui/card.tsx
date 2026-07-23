import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Card — surface container for spots, events, clubs, content (seed contract:
 * components/data-display/Card). Radius lg. `media` renders flush at the top,
 * `footer` below a divider, `interactive` lifts one shadow step on hover.
 */
const cardVariants = cva('overflow-hidden rounded-card border border-line bg-surface shadow-sm', {
  variants: {
    interactive: {
      true: 'cursor-pointer transition-[box-shadow,transform] duration-150 ease-standard hover:-translate-y-0.5 hover:shadow-lg',
      false: '',
    },
  },
  defaultVariants: { interactive: false },
});

const bodyPadding = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
} as const;

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  /** Content padding. @default 'md' */
  padding?: keyof typeof bodyPadding;
  /** Media rendered flush at the top (image, map thumbnail, route graphic). */
  media?: React.ReactNode;
  /** Footer rendered below a top divider. */
  footer?: React.ReactNode;
}

export function Card({
  className,
  interactive,
  padding = 'md',
  media,
  footer,
  children,
  ...props
}: CardProps) {
  return (
    <div data-slot="card" className={cn(cardVariants({ interactive }), className)} {...props}>
      {media ? <div className="overflow-hidden">{media}</div> : null}
      <div className={bodyPadding[padding]}>{children}</div>
      {footer ? <div className={cn('border-t border-line', bodyPadding[padding])}>{footer}</div> : null}
    </div>
  );
}
