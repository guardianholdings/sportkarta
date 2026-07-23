import * as React from 'react';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** @default 'md' */
  size?: 'sm' | 'md' | 'lg';
  /** Leading icon (18px, currentColor) — pass a Search icon for search fields. */
  iconLeft?: React.ReactNode;
  /** Trailing icon (18px). */
  iconRight?: React.ReactNode;
  /** Error state — rust border + ring. Pair with helper text in danger color. */
  invalid?: boolean;
}

/** Single-line text field; base for search inputs. Radius md. */
export declare function Input(props: InputProps): JSX.Element;
