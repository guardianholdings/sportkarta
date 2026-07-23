import React, { useState } from 'react';

/**
 * Select — native <select> styled to match Input, with a custom chevron.
 * Native for accessibility + mobile wheel pickers.
 */

const SIZES = {
  sm: { h: 'var(--control-sm)', fs: 14, px: 12 },
  md: { h: 'var(--control-md)', fs: 15, px: 14 },
  lg: { h: 'var(--control-lg)', fs: 16, px: 16 },
};

const Chevron = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function Select({
  size = 'md',
  invalid = false,
  disabled = false,
  children,
  style,
  ...rest
}) {
  const [focus, setFocus] = useState(false);
  const s = SIZES[size] || SIZES.md;
  const borderColor = invalid ? 'var(--danger)' : focus ? 'var(--brand)' : 'var(--border-strong)';

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: '100%' }}>
      <select
        disabled={disabled}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          width: '100%',
          height: s.h,
          padding: `0 ${s.px + 22}px 0 ${s.px}px`,
          background: disabled ? 'var(--paper-sunk)' : 'var(--surface)',
          border: `1px solid ${borderColor}`,
          borderRadius: 'var(--radius-md)',
          boxShadow: focus ? 'var(--ring)' : 'none',
          fontFamily: 'var(--font-sans)',
          fontSize: s.fs,
          color: 'var(--text-primary)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          outline: 'none',
          transition: 'border-color var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard)',
          ...style,
        }}
        {...rest}
      >
        {children}
      </select>
      <span style={{ position: 'absolute', right: s.px, pointerEvents: 'none', display: 'inline-flex', color: 'var(--text-muted)' }}>
        <Chevron />
      </span>
    </div>
  );
}
