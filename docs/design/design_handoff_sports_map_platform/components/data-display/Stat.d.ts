import * as React from 'react';

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The metric value — pre-formatted string or number (mono, tabular). */
  value: React.ReactNode;
  /** Caption under the value. */
  label: React.ReactNode;
  /** Optional leading icon (18px). */
  icon?: React.ReactNode;
  /** @default 'default' */
  tone?: 'default' | 'brand' | 'accent';
  /** @default 'left' */
  align?: 'left' | 'center';
}

/** Labelled metric; value in mono/tabular numerals. Profiles, leaderboards, spot detail. */
export declare function Stat(props: StatProps): JSX.Element;
