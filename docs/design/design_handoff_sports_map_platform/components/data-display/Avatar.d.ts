import * as React from 'react';

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Image URL. Falls back to initials from `name`. */
  src?: string;
  /** Full name — used for initials and img alt. */
  name?: string;
  /** Named size or custom px. @default 'md' */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
  /** Pine ring — use for the current user / "active" states. */
  ring?: boolean;
  /** Presence dot. */
  status?: 'online' | 'offline';
}

/** Circular user image with initials fallback. */
export declare function Avatar(props: AvatarProps): JSX.Element;
