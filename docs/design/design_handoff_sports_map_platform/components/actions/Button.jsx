import React, { useState } from 'react';

/**
 * Button — the primary action control.
 * Pill radius, Manrope 600. Interactive states handled inline so the
 * component is fully self-contained (no external CSS beyond tokens).
 */

const SIZES = {
  sm: { height: 'var(--control-sm)', padding: '0 16px', fontSize: 14, gap: 7, icon: 16 },
  md: { height: 'var(--control-md)', padding: '0 22px', fontSize: 15, gap: 8, icon: 20 },
  lg: { height: 'var(--control-lg)', padding: '0 28px', fontSize: 16, gap: 9, icon: 20 },
};

function palette(variant) {
  switch (variant) {
    case 'accent':
      return { bg: 'var(--accent)', bgHover: 'var(--accent-hover)', bgActive: 'var(--accent-active)', fg: 'var(--text-on-accent)', border: 'transparent' };
    case 'secondary':
      return { bg: 'var(--surface)', bgHover: 'var(--surface-2)', bgActive: 'var(--paper-sunk)', fg: 'var(--text-primary)', border: 'var(--border-strong)' };
    case 'ghost':
      return { bg: 'transparent', bgHover: 'var(--pine-50)', bgActive: 'var(--pine-100)', fg: 'var(--brand)', border: 'transparent' };
    case 'danger':
      return { bg: 'var(--danger)', bgHover: '#B93E2E', bgActive: '#A03626', fg: '#fff', border: 'transparent' };
    case 'primary':
    default:
      return { bg: 'var(--brand)', bgHover: 'var(--brand-hover)', bgActive: 'var(--brand-active)', fg: 'var(--text-on-brand)', border: 'transparent' };
  }
}

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  iconLeft,
  iconRight,
  disabled = false,
  type = 'button',
  children,
  style,
  ...rest
}) {
  const [hover, setHover] = useState(false);
  const [press, setPress] = useState(false);
  const s = SIZES[size] || SIZES.md;
  const p = palette(variant);

  const bg = disabled ? undefined : press ? p.bgActive : hover ? p.bgHover : p.bg;

  return (
    <button
      type={type}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPress(false); }}
      onMouseDown={() => setPress(true)}
      onMouseUp={() => setPress(false)}
      style={{
        display: block ? 'flex' : 'inline-flex',
        width: block ? '100%' : undefined,
        alignItems: 'center',
        justifyContent: 'center',
        gap: s.gap,
        height: s.height,
        padding: s.padding,
        fontFamily: 'var(--font-sans)',
        fontWeight: 600,
        fontSize: s.fontSize,
        lineHeight: 1,
        letterSpacing: '-0.01em',
        color: disabled ? 'var(--text-faint)' : p.fg,
        background: disabled ? 'var(--paper-sunk)' : bg,
        border: `1px solid ${disabled ? 'var(--border)' : p.border}`,
        borderRadius: 'var(--radius-pill)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transform: press && !disabled ? 'scale(0.97)' : 'scale(1)',
        transition: 'background var(--dur-fast) var(--ease-standard), transform var(--dur-micro) var(--ease-standard)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        ...style,
      }}
      {...rest}
    >
      {iconLeft && <span style={{ display: 'inline-flex', width: s.icon, height: s.icon }}>{iconLeft}</span>}
      {children}
      {iconRight && <span style={{ display: 'inline-flex', width: s.icon, height: s.icon }}>{iconRight}</span>}
    </button>
  );
}
