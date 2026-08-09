import React, { useState } from 'react';

/**
 * IconButton — a square/circular button carrying a single icon.
 * Used for map controls, toolbars, and compact actions. Always pass
 * an accessible `aria-label`.
 */

const SIZES = {
  sm: { box: 36, icon: 18 },
  md: { box: 44, icon: 20 },
  lg: { box: 52, icon: 24 },
};

function palette(variant) {
  switch (variant) {
    case 'solid':
      return {
        bg: 'var(--brand)',
        bgHover: 'var(--brand-hover)',
        bgActive: 'var(--brand-active)',
        fg: '#fff',
        border: 'transparent',
        shadow: 'none',
      };
    case 'floating': // sits on the map / imagery
      return {
        bg: 'var(--surface)',
        bgHover: 'var(--surface-2)',
        bgActive: 'var(--paper-sunk)',
        fg: 'var(--text-primary)',
        border: 'var(--border)',
        shadow: 'var(--shadow-float)',
      };
    case 'ghost':
      return {
        bg: 'transparent',
        bgHover: 'var(--pine-50)',
        bgActive: 'var(--pine-100)',
        fg: 'var(--text-secondary)',
        border: 'transparent',
        shadow: 'none',
      };
    case 'surface':
    default:
      return {
        bg: 'var(--surface)',
        bgHover: 'var(--surface-2)',
        bgActive: 'var(--paper-sunk)',
        fg: 'var(--text-primary)',
        border: 'var(--border-strong)',
        shadow: 'none',
      };
  }
}

export function IconButton({
  variant = 'surface',
  size = 'md',
  round = false,
  disabled = false,
  'aria-label': ariaLabel,
  children,
  style,
  ...rest
}) {
  const [hover, setHover] = useState(false);
  const [press, setPress] = useState(false);
  const s = SIZES[size] || SIZES.md;
  const p = palette(variant);
  const bg = disabled ? 'var(--paper-sunk)' : press ? p.bgActive : hover ? p.bgHover : p.bg;

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPress(false);
      }}
      onMouseDown={() => setPress(true)}
      onMouseUp={() => setPress(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: s.box,
        height: s.box,
        color: disabled ? 'var(--text-faint)' : p.fg,
        background: bg,
        border: `1px solid ${disabled ? 'var(--border)' : p.border}`,
        borderRadius: round ? 'var(--radius-circle)' : 'var(--radius-md)',
        boxShadow: disabled ? 'none' : p.shadow,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transform: press && !disabled ? 'scale(0.94)' : 'scale(1)',
        transition:
          'background var(--dur-fast) var(--ease-standard), transform var(--dur-micro) var(--ease-standard)',
        ...style,
      }}
      {...rest}
    >
      <span style={{ display: 'inline-flex', width: s.icon, height: s.icon }}>{children}</span>
    </button>
  );
}
