import * as React from 'react';

export interface MapMarkerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** @default 'pin' */
  variant?: 'pin' | 'dot' | 'cluster';
  /** Category color — pass a --cat-* token. @default var(--brand) */
  color?: string;
  /** Pin height basis in px. @default 40 */
  size?: number;
  /** Selected/open spot — scales up and lifts. */
  active?: boolean;
  /** Count for the `cluster` variant. */
  count?: number;
  /** White glyph inside a `pin` (a Lucide category icon). */
  icon?: React.ReactNode;
}

/** Signature map pin: category-colored teardrop with white glyph. Also dot & cluster. */
export declare function MapMarker(props: MapMarkerProps): JSX.Element;
