import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Radio — single-choice control; give every option in a group the same `name`
 * (seed contract: components/forms/Radio). Circular; pine when checked. The dot
 * scales in with a quick ease-out — NOT the trail overshoot: the seed reserves
 * bounce for marker drop + badge unlock, and "core UI never bounces"
 * (RECONCILIATION.md, resolving the Radio.prompt.md ↔ DESIGN_SYSTEM §3.7 tension).
 */
export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Optional inline label text. */
  label?: React.ReactNode;
}

export function Radio({ className, label, ...props }: RadioProps) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer select-none items-center gap-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
        className,
      )}
    >
      <input type="radio" className="peer sr-only" {...props} />
      <span className="grid size-5 place-items-center rounded-full border border-line-strong bg-surface transition-colors duration-150 ease-standard peer-checked:border-brand peer-checked:[&>span]:scale-100 peer-focus-visible:shadow-[var(--ring)]">
        <span className="size-2.5 scale-0 rounded-full bg-brand transition-transform duration-150 ease-out" />
      </span>
      {label ? <span className="text-body-sm text-ink">{label}</span> : null}
    </label>
  );
}
