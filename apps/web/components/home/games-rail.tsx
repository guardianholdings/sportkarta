'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A horizontal, snap-scrolling row of session cards (server-rendered children)
 * with back/forward buttons for pointer users. Touch scrolls natively; without
 * JavaScript it is still a scrollable list. The buttons disable themselves at
 * either end rather than scrolling into nothing.
 */
export function GamesRail({
  labels,
  children,
}: {
  labels: { prev: string; next: string };
  children: ReactNode;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      setEdges({
        start: list.scrollLeft <= 4,
        end: list.scrollLeft + list.clientWidth >= list.scrollWidth - 4,
      });
    };
    update();
    list.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      list.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  function scroll(direction: 1 | -1) {
    const list = listRef.current;
    if (!list) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollBy({
      left: direction * list.clientWidth * 0.85,
      behavior: reduce ? 'auto' : 'smooth',
    });
  }

  const button =
    'grid size-11 place-items-center rounded-full border border-line-strong bg-surface text-ink shadow-xs transition-colors duration-150 ease-standard hover:bg-surface-2 disabled:opacity-40';

  return (
    <div className="relative">
      <ul
        ref={listRef}
        // scroll-px matches the bleed padding: snapping aligns a card to the
        // scrollport's padded edge, not flush against the screen.
        className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto scroll-smooth px-4 pb-2 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:scroll-px-0 lg:px-0"
      >
        {children}
      </ul>
      <div className="mt-3 hidden justify-end gap-2 sm:flex">
        <button
          type="button"
          className={button}
          onClick={() => scroll(-1)}
          disabled={edges.start}
          aria-label={labels.prev}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={button}
          onClick={() => scroll(1)}
          disabled={edges.end}
          aria-label={labels.next}
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
