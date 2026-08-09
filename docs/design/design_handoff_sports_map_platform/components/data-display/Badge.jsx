import React from 'react';

/**
 * Badge — small non-interactive status / label pill.
 * `tone` maps to the semantic palette; `variant` soft (default) | solid | outline.
 * For clickable filters/categories use Chip instead.
 */

const TONES = {
  neutral: {
    soft: { bg: 'var(--surface-2)', fg: 'var(--text-secondary)', bd: 'var(--border)' },
    solid: { bg: 'var(--ink-soft)', fg: '#fff', bd: 'transparent' },
  },
  brand: {
    soft: { bg: 'var(--pine-50)', fg: 'var(--pine-700)', bd: 'var(--pine-200)' },
    solid: { bg: 'var(--brand)', fg: '#fff', bd: 'transparent' },
  },
  accent: {
    soft: { bg: 'var(--clay-50)', fg: 'var(--clay-700)', bd: 'var(--clay-200)' },
    solid: { bg: 'var(--accent)', fg: '#fff', bd: 'transparent' },
  },
  success: {
    soft: { bg: 'var(--success-bg)', fg: 'var(--success)', bd: 'var(--success-border)' },
    solid: { bg: 'var(--success)', fg: '#fff', bd: 'transparent' },
  },
  warning: {
    soft: { bg: 'var(--warning-bg)', fg: 'var(--warning)', bd: 'var(--warning-border)' },
    solid: { bg: 'var(--warning)', fg: '#fff', bd: 'transparent' },
  },
  danger: {
    soft: { bg: 'var(--danger-bg)', fg: 'var(--danger)', bd: 'var(--danger-border)' },
    solid: { bg: 'var(--danger)', fg: '#fff', bd: 'transparent' },
  },
  info: {
    soft: { bg: 'var(--info-bg)', fg: 'var(--info)', bd: 'var(--info-border)' },
    solid: { bg: 'var(--info)', fg: '#fff', bd: 'transparent' },
  },
};

export function Badge({ tone = 'neutral', variant = 'soft', icon, children, style, ...rest }) {
  const group = TONES[tone] || TONES.neutral;
  const t =
    variant === 'outline'
      ? { bg: 'transparent', fg: group.soft.fg, bd: group.soft.bd }
      : group[variant] || group.soft;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.4,
        letterSpacing: '-0.005em',
        borderRadius: 'var(--radius-pill)',
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.bd}`,
        whiteSpace: 'nowrap',
        ...style,
      }}
      {...rest}
    >
      {icon && <span style={{ display: 'inline-flex', width: 13, height: 13 }}>{icon}</span>}
      {children}
    </span>
  );
}
