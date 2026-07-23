import * as React from 'react';

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  label?: React.ReactNode;
  /** Shared across a group to make the choice single-select. */
  name?: string;
  value?: string;
}

/** Circular single-choice control. Share `name` across the group. */
export declare function Radio(props: RadioProps): JSX.Element;
