import * as React from 'react';

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  /** @default 'md' */
  size?: 'sm' | 'md';
  label?: React.ReactNode;
}

/** On/off toggle for instant settings (map layers, notifications). Pill track, pine when on. */
export declare function Switch(props: SwitchProps): JSX.Element;
