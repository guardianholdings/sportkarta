import React, { useState } from 'react';

/**
 * Checkbox — square selection control with a real (visually hidden) input
 * for accessibility. Controlled (checked) or uncontrolled (defaultChecked).
 */

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3.5 8.5l3 3 6-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function Checkbox({
  checked,
  defaultChecked = false,
  onChange,
  disabled = false,
  label,
  style,
  ...rest
}) {
  const controlled = checked !== undefined;
  const [internal, setInternal] = useState(defaultChecked);
  const [focus, setFocus] = useState(false);
  const on = controlled ? checked : internal;

  const handle = (e) => {
    if (!controlled) setInternal(e.target.checked);
    onChange && onChange(e);
  };

  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        ...style,
      }}
    >
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={handle}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
        {...rest}
      />
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          flex: 'none',
          borderRadius: 'var(--radius-xs)',
          border: `1px solid ${on ? 'var(--brand)' : 'var(--border-strong)'}`,
          background: on ? 'var(--brand)' : 'var(--surface)',
          color: '#fff',
          boxShadow: focus ? 'var(--ring)' : 'none',
          transition:
            'background var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard)',
        }}
      >
        {on && <Check />}
      </span>
      {label && (
        <span
          style={{ fontFamily: 'var(--font-sans)', fontSize: 15, color: 'var(--text-primary)' }}
        >
          {label}
        </span>
      )}
    </label>
  );
}
