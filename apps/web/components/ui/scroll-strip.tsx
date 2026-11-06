'use client';

import * as React from 'react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * ScrollStrip — the ONE horizontal row for tabs, hubs, section pills and
 * filter chips (UX audit 2026-10-31, V-27 and V-31: five pages each rolled
 * their own `-mx-4 overflow-x-auto px-4`, and only one of them brought the
 * current tab into view).
 *
 * The row scrolls sideways without a scrollbar track, fades its right edge
 * while there is more to the right (the hint that the row continues), and
 * centres the active item — `aria-current`, `aria-selected` or
 * `aria-pressed` — on mount and whenever `activeKey` changes. It does that
 * by setting its own scrollLeft, never with scrollIntoView: a strip above
 * the fold (the office hubs on a settings page opened at #plashtaniya)
 * would otherwise pull the whole page up to itself. Items are the caller's
 * links or buttons, so the keyboard reaches every one, and an item reached
 * BY THE KEYBOARD (`:focus-visible`) is centred the same way — never one a
 * pointer is pressing: a pointer focuses a link on mousedown, and a strip
 * that scrolled between mousedown and mouseup would move the pill out from
 * under the tap and swallow the click.
 *
 * `bleed` (default) pulls the row to the screen edge with `-mx-4 px-4`, so
 * the first pill sits on the page's own gutter and the fade covers the last
 * pill, not a margin. `wrapFrom` lets a row that fits a desktop (the admin's
 * sixteen tabs, a filter row) wrap there instead of scrolling. The fade reads
 * `--strip-bg` (the page's `--paper` by default) so it matches whatever the
 * row stands on. `className` dresses the OUTER element — a sticky phone row
 * puts `max-sm:sticky` and its background there.
 */
export interface ScrollStripProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  'className' | 'children'
> {
  /** The scrolling element itself: a nav for links that navigate. */
  as?: 'div' | 'nav';
  /** Re-centre the active item when this changes (the pathname, a filter). */
  activeKey?: string;
  activeSelector?: string;
  /** Wrap into rows from this breakpoint instead of scrolling. */
  wrapFrom?: 'sm' | 'lg';
  bleed?: boolean;
  /** Gap utility between the items. */
  gap?: 'gap-1' | 'gap-1.5' | 'gap-2';
  className?: string;
  children: React.ReactNode;
}

const ACTIVE = '[aria-current], [aria-selected="true"], [aria-pressed="true"]';

/** Scroll `item` to the middle of `strip` by moving the strip alone. */
function centre(strip: HTMLElement, item: HTMLElement): void {
  if (strip.scrollWidth <= strip.clientWidth) return;
  const left = item.offsetLeft - (strip.clientWidth - item.offsetWidth) / 2;
  strip.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
}

export function ScrollStrip({
  as: Tag = 'div',
  activeKey,
  activeSelector = ACTIVE,
  wrapFrom,
  bleed = true,
  gap = 'gap-1',
  className,
  children,
  ...rest
}: ScrollStripProps) {
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  const update = () => {
    const strip = ref.current;
    if (strip) setMore(strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1);
  };

  // The fade: on while the row has more to the right, off at the end — and
  // off entirely when everything fits, so a short row shows nothing.
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    update();
    strip.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(strip);
    return () => {
      strip.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, []);

  // On mount and whenever the active item changes: centre it, then measure
  // again — a strip that persists across navigations (the office sections
  // row) may now hold more or fewer items than the last measurement saw.
  useEffect(() => {
    const strip = ref.current;
    const active = strip?.querySelector<HTMLElement>(activeSelector);
    if (strip && active) centre(strip, active);
    update();
  }, [activeKey, activeSelector]);

  // From the breakpoint: no bleed on the outer, no inset on the inner row.
  const wrap =
    wrapFrom === 'sm'
      ? 'sm:mx-0 sm:[&>*]:flex-wrap sm:[&>*]:overflow-visible sm:[&>*]:px-0 sm:after:hidden'
      : wrapFrom === 'lg'
        ? 'lg:mx-0 lg:[&>*]:flex-wrap lg:[&>*]:overflow-visible lg:[&>*]:px-0 lg:after:hidden'
        : null;

  return (
    <div
      data-more={more || undefined}
      className={cn(
        'relative after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-10 after:opacity-0 after:transition-opacity after:duration-150 after:ease-standard after:content-[""] data-[more]:after:opacity-100',
        'after:bg-[linear-gradient(to_left,var(--strip-bg,var(--paper)),transparent)]',
        bleed && '-mx-4',
        wrap,
        className,
      )}
    >
      <Tag
        // The `as` tag is one of two static strings; the ref type follows the element.
        ref={ref as React.Ref<HTMLDivElement>}
        onFocusCapture={(event) => {
          const strip = ref.current;
          const item = event.target;
          if (
            strip &&
            item instanceof HTMLElement &&
            item !== strip &&
            item.matches(':focus-visible')
          ) {
            centre(strip, item);
          }
        }}
        className={cn(
          'scrollbar-none relative flex overflow-x-auto overscroll-x-contain',
          bleed && 'px-4',
          gap,
        )}
        {...rest}
      >
        {children}
      </Tag>
    </div>
  );
}
