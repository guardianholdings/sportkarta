import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * SegmentedControl — compact single-select for switching views (Map/List/Feed).
 * Seed contract: components/navigation/SegmentedControl. Controlled via
 * value+onChange. Active segment = surface fill + shadow-sm + pine text.
 */
export interface SegmentItem {
  value: string;
  label: React.ReactNode;
  /** Optional 18px icon. */
  icon?: React.ReactNode;
}

export interface SegmentedControlProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  items: SegmentItem[];
  /** Selected value (controlled). */
  value: string;
  onChange?: (value: string) => void;
  /** @default 'md' */
  size?: 'sm' | 'md';
  fullWidth?: boolean;
}

export function SegmentedControl({
  className,
  items,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  ...props
}: SegmentedControlProps) {
  return (
    <div
      role="tablist"
      data-slot="segmented-control"
      className={cn('inline-flex items-center gap-1 rounded-pill bg-paper-sunk p-1', fullWidth && 'flex w-full', className)}
      {...props}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(item.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-pill font-medium transition-[background-color,color,box-shadow] duration-150 ease-standard [&_svg]:shrink-0',
              size === 'sm' ? 'h-8 px-3 text-body-sm' : 'h-9 px-4 text-body-sm',
              fullWidth && 'flex-1',
              active
                ? 'bg-surface text-brand shadow-sm'
                : 'text-ink-soft hover:text-ink',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
