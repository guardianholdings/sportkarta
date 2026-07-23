import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * MapMarker — the pin that plots spots on the map (seed contract:
 * components/map/MapMarker). Colour by activity category (pass a --cat-* token);
 * the glyph identifies the sport. Built from CSS — no image assets.
 *
 * `active` scales the selected spot up and plays the "drop" — the ONLY core-UI
 * use of the trail overshoot (`--ease-trail`), alongside badge unlock.
 */
export interface MapMarkerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** @default 'pin' */
  variant?: 'pin' | 'dot' | 'cluster';
  /** Category colour — pass a --cat-* token. @default var(--brand) */
  color?: string;
  /** Pin height basis in px. @default 40 */
  size?: number;
  /** Selected/open spot — scales up, lifts, and drops in. */
  active?: boolean;
  /** Count for the `cluster` variant. */
  count?: number;
  /** White glyph inside a `pin` (a Lucide category icon). */
  icon?: React.ReactNode;
}

export function MapMarker({
  className,
  variant = 'pin',
  color = 'var(--brand)',
  size = 40,
  active = false,
  count,
  icon,
  style,
  ...props
}: MapMarkerProps) {
  if (variant === 'dot') {
    const d = Math.round(size * 0.4);
    return (
      <span
        data-slot="map-marker"
        className={cn('inline-block rounded-full shadow-sm ring-2 ring-surface', className)}
        style={{ width: d, height: d, background: color, ...style }}
        {...props}
      />
    );
  }

  if (variant === 'cluster') {
    return (
      <span
        data-slot="map-marker"
        className={cn(
          'inline-grid place-items-center rounded-full font-mono text-body-sm font-semibold text-on-brand shadow-float ring-2 ring-surface',
          className,
        )}
        style={{ width: size, height: size, background: color, ...style }}
        {...props}
      >
        {count}
      </span>
    );
  }

  // pin — teardrop with a white ring and a centred white glyph
  return (
    <span
      data-slot="map-marker"
      className={cn('relative inline-block', active && 'z-10 animate-marker-drop', className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <span
        className="absolute inset-0 shadow-md transition-transform duration-150 ease-standard"
        style={{
          background: color,
          border: '3px solid var(--surface)' /* design-ok: seed teardrop white ring */,
          borderRadius: '50% 50% 50% 4px' /* design-ok: seed teardrop geometry */,
          transform: active ? 'rotate(45deg) scale(1.12)' : 'rotate(45deg)',
        }}
      />
      <span className="absolute inset-0 grid place-items-center text-on-brand [&_svg]:shrink-0">
        {icon}
      </span>
    </span>
  );
}
