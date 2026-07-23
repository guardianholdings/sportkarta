import React, { useState } from 'react';

/**
 * Radio — circular single-choice control. Group with a shared `name`.
 * Controlled (checked) or uncontrolled (defaultChecked).
 */

export function Radio({
  checked,
  defaultChecked = false,
  onChange,
  disabled = false,
  label,
  name,
  value,
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
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, ...style }}>
      <input
        type="radio"
        name={name}
        value={value}
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
          borderRadius: '50%',
          border: `1px solid ${on ? 'var(--brand)' : 'var(--border-strong)'}`,
          background: 'var(--surface)',
          boxShadow: focus ? 'var(--ring)' : 'none',
          transition: 'border-color var(--dur-fast) var(--ease-standard)',
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: 'var(--brand)',
            transform: on ? 'scale(1)' : 'scale(0)',
            transition: 'transform var(--dur-fast) var(--ease-trail)',
          }}
        />
      </span>
      {label && <span style={{ fontFamily: 'var(--font-sans)', fontSize: 15, color: 'var(--text-primary)' }}>{label}</span>}
    </label>
  );
}
