import * as React from 'react';

export interface ChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** Selected/active state. */
  selected?: boolean;
  /** Category/accent color (e.g. var(--cat-bike)). @default var(--brand) */
  color?: string;
  /** Optional icon; when omitted a color dot is shown. */
  icon?: React.ReactNode;
  disabled?: boolean;
  children?: React.ReactNode;
}

/** Interactive selectable pill for filters & activity categories. Pass the category color. */
export declare function Chip(props: ChipProps): JSX.Element;
