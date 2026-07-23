import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Avatar — circular user image with initials fallback (seed contract:
 * components/data-display/Avatar). `ring` marks the current user; `status`
 * shows a presence dot. Overlap several with negative margin for a stack.
 */
const SIZE_PX = { xs: 24, sm: 32, md: 40, lg: 48, xl: 64 } as const;

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Image URL. Falls back to initials from `name`. */
  src?: string;
  /** Full name — used for initials and img alt. */
  name?: string;
  /** Named size or custom px. @default 'md' */
  size?: keyof typeof SIZE_PX | number;
  /** Pine ring — current user / "active". */
  ring?: boolean;
  /** Presence dot. */
  status?: 'online' | 'offline';
}

function initials(name?: string): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar({ className, src, name, size = 'md', ring, status, ...props }: AvatarProps) {
  const px = typeof size === 'number' ? size : SIZE_PX[size];
  const dot = Math.max(8, Math.round(px * 0.3));

  return (
    <span
      data-slot="avatar"
      className={cn(
        'relative inline-grid select-none place-items-center overflow-visible rounded-full bg-brand-subtle font-semibold text-brand',
        ring && 'ring-2 ring-brand',
        className,
      )}
      style={{ width: px, height: px, fontSize: Math.round(px * 0.4) }}
      {...props}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name ?? ''}
          className="absolute inset-0 h-full w-full rounded-full object-cover"
        />
      ) : (
        <span aria-hidden={!name}>{initials(name)}</span>
      )}
      {status ? (
        <span
          className={cn(
            'absolute bottom-0 right-0 block rounded-full border-2 border-surface',
            status === 'online' ? 'bg-success' : 'bg-text-faint',
          )}
          style={{ width: dot, height: dot }}
        />
      ) : null}
    </span>
  );
}
