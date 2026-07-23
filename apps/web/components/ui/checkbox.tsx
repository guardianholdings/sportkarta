import { Check } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Checkbox — multi-select control with an accessible hidden input (seed
 * contract: components/forms/Checkbox). Radius xs; pine when checked. The check
 * glyph is always white and only shows once the box turns pine.
 */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Optional inline label text. */
  label?: React.ReactNode;
}

export function Checkbox({ className, label, ...props }: CheckboxProps) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer select-none items-center gap-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
        className,
      )}
    >
      <input type="checkbox" className="peer sr-only" {...props} />
      <span className="grid size-5 place-items-center rounded-xs border border-line-strong bg-surface transition-colors duration-150 ease-standard peer-checked:border-brand peer-checked:bg-brand peer-focus-visible:shadow-[var(--ring)]">
        <Check size={14} className="text-on-brand" aria-hidden="true" />
      </span>
      {label ? <span className="text-body-sm text-ink">{label}</span> : null}
    </label>
  );
}
