import React from 'react';

/**
 * Stat — a labelled metric. Value renders in the mono face with tabular
 * numerals (the "instrument" look). Use on profiles, leaderboards,
 * spot detail, and challenge cards.
 */

export function Stat({ value, label, icon, tone = 'default', align = 'left', style, ...rest }) {
  const color =
    tone === 'brand' ? 'var(--brand)' : tone === 'accent' ? 'var(--accent)' : 'var(--ink)';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        alignItems: align === 'center' ? 'center' : 'flex-start',
        ...style,
      }}
      {...rest}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        {icon && (
          <span style={{ display: 'inline-flex', width: 18, height: 18, color }}>{icon}</span>
        )}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 26,
            letterSpacing: '-0.01em',
            color,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.1,
          }}
        >
          {value}
        </span>
      </span>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-muted)' }}>
        {label}
      </span>
    </div>
  );
}
