import * as React from 'react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * - `surface`  outlined, default toolbar control
   * - `solid`    pine filled
   * - `floating` white with float shadow — for controls over the map/imagery
   * - `ghost`    transparent
   * @default 'surface'
   */
  variant?: 'surface' | 'solid' | 'floating' | 'ghost';
  /** @default 'md' */
  size?: 'sm' | 'md' | 'lg';
  /** Circular instead of md-rounded square. */
  round?: boolean;
  /** REQUIRED for accessibility — the action name. */
  'aria-label': string;
}

/** Single-icon button for map controls, toolbars, and compact actions. */
export declare function IconButton(props: IconButtonProps): JSX.Element;
