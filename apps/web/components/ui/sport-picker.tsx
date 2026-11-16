'use client';

import * as React from 'react';
import { useState } from 'react';

import { Chip, chipClass } from './chip';

export interface SportOption {
  value: string;
  label: string;
  /** The activity's colour token (e.g. var(--cat-bike)); the brand green when absent. */
  color?: string;
  icon?: React.ReactNode;
}

export interface SportPickerLabels {
  /** «Покажи всички (N)» — formatted by the caller, with the count. */
  showAll: string;
  showFewer: string;
}

/**
 * SportPicker — the ONE control for choosing sports (UX audit 2026-10-31,
 * V-32 and DR-13): /dobavi, /klubove/zayavka and the club's settings used
 * three, two of them a fixed-height box of 26px checkbox rows scrolling
 * inside the page. Now a wrapped row of 44px toggle chips with no inner
 * scroll; a long list shows its first `visibleCount` — and anything already
 * chosen — behind a «Покажи всички» button.
 *
 * The selection posts as hidden inputs under `name`, so a server action reads
 * `formData.getAll(name)` exactly as it read the checkboxes — and only values
 * the picker can show: a stored value that is no longer an option has no chip
 * to deselect and would otherwise fail the whole save as `sport_invalid`.
 * Uncontrolled by default (`defaultSelected`); pass `selected` and `onChange`
 * to own the state, as /dobavi does for its before-submit check. Words arrive
 * as props: a client component reads no catalogue of its own.
 */
export function SportPicker({
  name,
  options,
  defaultSelected = [],
  selected,
  onChange,
  visibleCount = 12,
  labels,
  className,
}: {
  name: string;
  options: readonly SportOption[];
  defaultSelected?: readonly string[];
  selected?: ReadonlySet<string>;
  onChange?: (next: Set<string>) => void;
  /** How many chips a long list shows before «Покажи всички». */
  visibleCount?: number;
  labels: SportPickerLabels;
  className?: string;
}) {
  const known = (value: string) => options.some((option) => option.value === value);
  const [inner, setInner] = useState<Set<string>>(() => new Set(defaultSelected.filter(known)));
  const [expanded, setExpanded] = useState(false);
  const current = selected ?? inner;
  const long = options.length > visibleCount;
  const shown =
    expanded || !long
      ? options
      : options.filter((option, index) => index < visibleCount || current.has(option.value));

  function toggle(value: string) {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    if (selected === undefined) setInner(next);
    onChange?.(next);
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {shown.map((option) => (
          <Chip
            key={option.value}
            selected={current.has(option.value)}
            color={option.color}
            icon={option.icon}
            onClick={() => toggle(option.value)}
            className="h-auto min-h-11 py-2"
          >
            {option.label}
          </Chip>
        ))}
        {long && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className={chipClass({ className: 'h-auto min-h-11 border-dashed py-2' })}
          >
            {expanded ? labels.showFewer : labels.showAll}
          </button>
        )}
      </div>
      {[...current].filter(known).map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
      ))}
    </div>
  );
}
