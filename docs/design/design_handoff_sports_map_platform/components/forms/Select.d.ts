import * as React from 'react';

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** @default 'md' */
  size?: 'sm' | 'md' | 'lg';
  invalid?: boolean;
  /** <option> / <optgroup> children. */
  children?: React.ReactNode;
}

/** Native select styled to match Input, with a custom chevron. */
export declare function Select(props: SelectProps): JSX.Element;
