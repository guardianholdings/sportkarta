import * as React from 'react';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Controlled checked state. Omit for uncontrolled (use defaultChecked). */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  /** Optional inline label text. */
  label?: React.ReactNode;
}

/** Square selection control (multi-select). Radius xs; pine when checked. */
export declare function Checkbox(props: CheckboxProps): JSX.Element;
