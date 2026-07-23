import React, { useState } from 'react';

/**
 * Input — single-line text field. Supports leading/trailing icon slots,
 * sizes, and an invalid state. Focus draws a pine ring; invalid draws rust.
 * Use as the base for search fields (pass a Search icon as iconLeft).
 */

const SIZES = {
  sm: { h: 'var(--control-sm)', fs: 14, px: 12 },
  md: { h: 'var(--control-md)', fs: 15, px: 14 },
  lg: { h: 'var(--control-lg)', fs: 16, px: 16 },
};

export function Input({
  size = 'md',
  iconLeft,
  iconRight,
  invalid = false,
  disabled = false,
  style,
  ...rest
}) {
  const [focus, setFocus] = useState(false);
  const s = SIZES[size] || SIZES.md;
  const borderColor = invalid ? 'var(--danger)' : focus ? 'var(--brand)' : 'var(--border-strong)';
  const ring = focus ? (invalid ? '0 0 0 3px rgba(206,74,56,0.22)' : 'var(--ring)') : 'none';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        height: s.h,
        padding: `0 ${s.px}px`,
        background: disabled ? 'var(--paper-sunk)' : 'var(--surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: ring,
        transition: 'border-color var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard)',
        ...style,
      }}
    >
      {iconLeft && <span style={{ display: 'inline-flex', width: 18, height: 18, color: 'var(--text-muted)', flex: 'none' }}>{iconLeft}</span>}
      <input
        disabled={disabled}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontFamily: 'var(--font-sans)',
          fontSize: s.fs,
          color: 'var(--text-primary)',
        }}
        {...rest}
      />
      {iconRight && <span style={{ display: 'inline-flex', width: 18, height: 18, color: 'var(--text-muted)', flex: 'none' }}>{iconRight}</span>}
    </div>
  );
}
