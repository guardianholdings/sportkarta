import React from 'react';

/**
 * Avatar — circular user image with initials fallback and optional
 * active ring / status dot. Named sizes or a custom pixel number.
 */

const SIZES = { xs: 24, sm: 32, md: 40, lg: 56, xl: 80 };

export function Avatar({ src, name = '', size = 'md', ring = false, status, style, ...rest }) {
  const px = typeof size === 'number' ? size : (SIZES[size] || 40);
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
  const dot = Math.max(8, Math.round(px * 0.28));

  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: px, height: px, flex: 'none', ...style }} {...rest}>
      <span
        style={{
          width: px,
          height: px,
          borderRadius: '50%',
          overflow: 'hidden',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--pine-100)',
          color: 'var(--pine-700)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 700,
          fontSize: Math.round(px * 0.38),
          border: ring ? '2px solid var(--brand)' : '1px solid var(--border)',
          boxSizing: 'border-box',
        }}
      >
        {src ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials}
      </span>
      {status && (
        <span
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: dot,
            height: dot,
            borderRadius: '50%',
            background: status === 'online' ? 'var(--success)' : 'var(--text-faint)',
            border: '2px solid var(--surface)',
          }}
        />
      )}
    </span>
  );
}
