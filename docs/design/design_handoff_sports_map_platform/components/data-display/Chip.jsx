import React, { useState } from 'react';

/**
 * Chip — interactive, selectable pill for filters and activity categories.
 * Pass the activity's category color via `color`; unselected shows a color
 * dot, selected fills with a tint of that color. For static labels use Badge.
 */

export function Chip({
  selected = false,
  color = 'var(--brand)',
  icon,
  disabled = false,
  onClick,
  children,
  style,
  ...rest
}) {
  const [hover, setHover] = useState(false);

  const bg = selected
    ? `color-mix(in srgb, ${color} 14%, var(--surface))`
    : hover && !disabled ? 'var(--surface-2)' : 'var(--surface)';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        height: 36,
        padding: '0 14px',
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        borderRadius: 'var(--radius-pill)',
        background: bg,
        color: selected ? color : 'var(--text-secondary)',
        border: `1px solid ${selected ? color : 'var(--border-strong)'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard)',
        ...style,
      }}
      {...rest}
    >
      {icon
        ? <span style={{ display: 'inline-flex', width: 16, height: 16, color }}>{icon}</span>
        : <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flex: 'none' }} />}
      {children}
    </button>
  );
}
