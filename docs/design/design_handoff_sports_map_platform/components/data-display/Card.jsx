import React, { useState } from 'react';

/**
 * Card — surface container for spots, events, clubs, and content.
 * Optional `media` renders flush at the top (image/map). `interactive`
 * adds a hover lift for whole-card links. Radius lg, hairline border,
 * soft shadow — separation comes mostly from the border.
 */

const PAD = { none: 0, sm: 'var(--space-3)', md: 'var(--space-4)', lg: 'var(--space-6)' };

export function Card({
  interactive = false,
  padding = 'md',
  media,
  footer,
  style,
  children,
  ...rest
}) {
  const [hover, setHover] = useState(false);
  const lifted = interactive && hover;

  return (
    <div
      onMouseEnter={() => interactive && setHover(true)}
      onMouseLeave={() => interactive && setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        boxShadow: lifted ? 'var(--shadow-lg)' : 'var(--shadow-sm)',
        transform: lifted ? 'translateY(-2px)' : 'none',
        transition: 'box-shadow var(--dur-base) var(--ease-standard), transform var(--dur-base) var(--ease-standard)',
        cursor: interactive ? 'pointer' : 'default',
        ...style,
      }}
      {...rest}
    >
      {media && <div style={{ flex: 'none' }}>{media}</div>}
      <div style={{ padding: PAD[padding], flex: 1 }}>{children}</div>
      {footer && (
        <div style={{ padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border)' }}>{footer}</div>
      )}
    </div>
  );
}
