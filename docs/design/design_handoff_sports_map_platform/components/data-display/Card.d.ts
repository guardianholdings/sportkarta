import * as React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Whole-card link/button behaviour — adds a hover lift + pointer. */
  interactive?: boolean;
  /** Content padding. @default 'md' */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Media rendered flush at the top (image, map thumbnail, route graphic). */
  media?: React.ReactNode;
  /** Footer rendered below a top divider. */
  footer?: React.ReactNode;
  children?: React.ReactNode;
}

/** Surface container for spots, events, clubs, and content. Radius lg. */
export declare function Card(props: CardProps): JSX.Element;
