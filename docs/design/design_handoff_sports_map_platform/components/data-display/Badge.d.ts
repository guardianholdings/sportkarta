import * as React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic tone. @default 'neutral' */
  tone?: 'neutral' | 'brand' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
  /** @default 'soft' */
  variant?: 'soft' | 'solid' | 'outline';
  /** Optional leading icon (13px). */
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

/** Small non-interactive status/label pill. For clickable filters use Chip. */
export declare function Badge(props: BadgeProps): JSX.Element;
