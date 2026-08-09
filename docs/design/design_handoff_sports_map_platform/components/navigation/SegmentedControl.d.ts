import * as React from 'react';

export interface SegmentItem {
  value: string;
  label: React.ReactNode;
  /** Optional 18px icon. */
  icon?: React.ReactNode;
}

export interface SegmentedControlProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onChange'
> {
  items: SegmentItem[];
  /** Selected value (controlled). */
  value: string;
  onChange?: (value: string) => void;
  /** @default 'md' */
  size?: 'sm' | 'md';
  fullWidth?: boolean;
}

/** Compact single-select for switching views (Map/List/Feed). */
export declare function SegmentedControl(props: SegmentedControlProps): JSX.Element;
