import React from 'react';

/**
 * MapMarker — the signature map pin. A category-colored teardrop with a
 * white glyph, built with the CSS border-radius pin trick (no SVG art).
 * Variants: `pin` (default), `dot` (zoomed-out / minor), `cluster` (count).
 * `active` scales it up and lifts it for the selected/open spot.
 */

export function MapMarker({
  variant = 'pin',
  color = 'var(--brand)',
  size = 40,
  active = false,
  count,
  icon,
  style,
  ...rest
}) {
  const scale = active ? 1.14 : 1;

  if (variant === 'dot') {
    const d = size * 0.55;
    return (
      <span
        style={{
          display: 'inline-block',
          width: d,
          height: d,
          borderRadius: '50%',
          background: color,
          border: '2.5px solid var(--surface)',
          boxShadow: 'var(--shadow-float)',
          transform: `scale(${scale})`,
          transition: 'transform var(--dur-base) var(--ease-trail)',
          ...style,
        }}
        {...rest}
      />
    );
  }

  if (variant === 'cluster') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          color: '#fff',
          border: '3px solid var(--surface)',
          boxShadow: 'var(--shadow-float)',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: Math.round(size * 0.34),
          fontVariantNumeric: 'tabular-nums',
          transform: `scale(${scale})`,
          ...style,
        }}
        {...rest}
      >
        {count}
      </span>
    );
  }

  // pin (teardrop)
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: size,
        height: size * 1.32,
        transform: `scale(${scale})`,
        transformOrigin: 'bottom center',
        transition: 'transform var(--dur-base) var(--ease-trail)',
        ...style,
      }}
      {...rest}
    >
      <span
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          background: color,
          borderRadius: '50% 50% 50% 0',
          transform: 'rotate(45deg)',
          border: '2.5px solid var(--surface)',
          boxSizing: 'border-box',
          boxShadow: 'var(--shadow-float)',
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: size * 0.15,
          left: size * 0.15,
          width: size * 0.7,
          height: size * 0.7,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
        }}
      >
        <span style={{ display: 'inline-flex', width: size * 0.44, height: size * 0.44 }}>
          {icon}
        </span>
      </span>
    </span>
  );
}
