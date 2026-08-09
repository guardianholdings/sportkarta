import React, { useState } from 'react';

/**
 * Switch — on/off toggle for instant settings (e.g. map layers).
 * Track turns pine when on. Accessible hidden checkbox underneath.
 */

const SIZES = {
  sm: { w: 38, h: 22, knob: 16 },
  md: { w: 46, h: 26, knob: 20 },
};

export function Switch({
  checked,
  defaultChecked = false,
  onChange,
  disabled = false,
  size = 'md',
  label,
  style,
  ...rest
}) {
  const controlled = checked !== undefined;
  const [internal, setInternal] = useState(defaultChecked);
  const [focus, setFocus] = useState(false);
  const on = controlled ? checked : internal;
  const s = SIZES[size] || SIZES.md;
  const pad = (s.h - s.knob) / 2;

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
        role="switch"
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
          position: 'relative',
          display: 'inline-block',
          width: s.w,
          height: s.h,
          flex: 'none',
          borderRadius: 'var(--radius-pill)',
          background: on ? 'var(--brand)' : 'var(--border-strong)',
          boxShadow: focus ? 'var(--ring)' : 'none',
          transition: 'background var(--dur-base) var(--ease-standard)',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: pad,
            left: on ? s.w - s.knob - pad : pad,
            width: s.knob,
            height: s.knob,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: 'var(--shadow-sm)',
            transition: 'left var(--dur-base) var(--ease-standard)',
          }}
        />
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
