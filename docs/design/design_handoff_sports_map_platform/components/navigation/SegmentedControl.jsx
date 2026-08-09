import React from 'react';

/**
 * SegmentedControl — compact single-select for switching views
 * (Map / List / Feed) or toggling small option sets. The selected
 * segment rides a white pill inside a sunken track.
 */

export function SegmentedControl({
  items = [],
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  style,
  ...rest
}) {
  const h = size === 'sm' ? 36 : 44;
  const fs = size === 'sm' ? 13 : 14;

  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        width: fullWidth ? '100%' : 'auto',
        padding: 4,
        gap: 2,
        background: 'var(--paper-sunk)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-pill)',
        ...style,
      }}
      {...rest}
    >
      {items.map((it) => {
        const sel = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={sel}
            onClick={() => onChange && onChange(it.value)}
            style={{
              flex: fullWidth ? 1 : 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              height: h - 8,
              padding: '0 16px',
              fontFamily: 'var(--font-sans)',
              fontWeight: 600,
              fontSize: fs,
              letterSpacing: '-0.005em',
              borderRadius: 'var(--radius-pill)',
              border: 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              color: sel ? 'var(--brand)' : 'var(--text-secondary)',
              background: sel ? 'var(--surface)' : 'transparent',
              boxShadow: sel ? 'var(--shadow-sm)' : 'none',
              transition:
                'color var(--dur-fast) var(--ease-standard), background var(--dur-fast) var(--ease-standard)',
            }}
          >
            {it.icon && (
              <span style={{ display: 'inline-flex', width: 18, height: 18 }}>{it.icon}</span>
            )}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
