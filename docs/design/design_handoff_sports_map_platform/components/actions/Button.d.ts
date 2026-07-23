import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual role.
   * - `primary`   pine, the default action
   * - `accent`    clay/amber — reserved for one hero CTA per view (esp. on photography)
   * - `secondary` outlined surface button
   * - `ghost`     text-only, pine
   * - `danger`    destructive
   * @default 'primary'
   */
  variant?: 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
  /** @default 'md' — sm 36 / md 44 / lg 52 px tall */
  size?: 'sm' | 'md' | 'lg';
  /** Stretch to fill the container width. */
  block?: boolean;
  /** Icon node before the label. Use a 20px Lucide line icon, currentColor. */
  iconLeft?: React.ReactNode;
  /** Icon node after the label. */
  iconRight?: React.ReactNode;
}

/** Primary action control. Pill radius; sentence-case labels, verb-first. */
export declare function Button(props: ButtonProps): JSX.Element;
