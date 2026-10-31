'use client';

import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { gsap, MOTION_OK, useGSAP } from '@/components/motion/gsap';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { DeviceFrame } from './device-frame';
import type { Shot } from './shots';

export interface ExplorerRow {
  key: string;
  title: string;
  body: string;
  /** The tier's label when the row is above the entry tier, else null. */
  tier: string | null;
  /** Behind a service the operator has not switched on. */
  soon: boolean;
}

export interface ExplorerArea {
  key: string;
  title: string;
  lead: string;
  shot: Shot | null;
  shotAlt: string;
  rows: ExplorerRow[];
}

export interface ExplorerLabels {
  areas: string;
  searchLabel: string;
  searchPlaceholder: string;
  noResults: string;
  matchesOne: string;
  matchesOther: string;
  total: string;
  soon: string;
  pause: string;
  resume: string;
  clear: string;
}

/** The event the «Един ден в клуба» chips send to open an area here. */
export const EXPLORER_OPEN_EVENT = 'pops:explorer-open';

const AUTOPLAY_MS = 6500;

function normalise(text: string): string {
  return text.toLocaleLowerCase('bg-BG').normalize('NFC');
}

/**
 * The office explorer — the complete catalogue as a product tour: the areas
 * of the office as tabs, the real screen of each, its functions sliding in,
 * and a search over every function of every area. It turns the areas by
 * itself every few seconds until the reader touches it (never under reduced
 * motion), so a page left open shows the whole office. Every panel is in the
 * HTML, hidden or not — a crawler reads all of it.
 */
export function OfficeExplorer({
  areas,
  labels,
}: {
  areas: ExplorerArea[];
  labels: ExplorerLabels;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [autoplay, setAutoplay] = useState(false);
  const [inView, setInView] = useState(false);
  const touched = useRef(false);

  const needle = normalise(query.trim());
  const results = useMemo(() => {
    if (!needle) return [];
    return areas.flatMap((area) =>
      area.rows
        .filter((row) => normalise(`${row.title} ${row.body}`).includes(needle))
        .map((row) => ({ area, row })),
    );
  }, [areas, needle]);

  const current = areas[active] ?? areas[0];

  function open(index: number, byUser = true) {
    if (byUser) {
      touched.current = true;
      setAutoplay(false);
    }
    setActive(((index % areas.length) + areas.length) % areas.length);
  }

  // Autoplay: only once visible, only with motion allowed, only until touched.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setInView(visible);
        if (visible && !touched.current) setAutoplay(true);
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!autoplay || !inView || needle) return;
    const timer = window.setInterval(() => setActive((i) => (i + 1) % areas.length), AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [autoplay, inView, needle, areas.length]);

  // The day's chips (day-in-club.tsx) open an area here.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      const index = areas.findIndex((area) => area.key === key);
      if (index >= 0) {
        setQuery('');
        open(index);
      }
    };
    window.addEventListener(EXPLORER_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(EXPLORER_OPEN_EVENT, onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` is stable enough; areas never change
  }, [areas]);

  // The rows of the area that just opened slide in; the picture fades over.
  useGSAP(
    () => {
      const scope = root.current;
      if (!scope) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const panel = scope.querySelector<HTMLElement>(`[data-panel="${current?.key}"]`);
        if (!panel) return;
        gsap.from(panel.querySelectorAll('[data-row]'), {
          y: 10,
          opacity: 0,
          duration: 0.4,
          ease: 'power2.out',
          stagger: 0.035,
          clearProps: 'transform',
        });
        const picture = panel.querySelector('figure');
        if (picture) {
          gsap.fromTo(
            picture,
            { opacity: 0, scale: 1.02 },
            { opacity: 1, scale: 1, duration: 0.5, ease: 'power2.out', clearProps: 'transform' },
          );
        }
        const bar = scope.querySelector<HTMLElement>('[data-autobar]');
        if (bar) {
          gsap.killTweensOf(bar);
          if (autoplay && inView && !needle) {
            gsap.fromTo(
              bar,
              { scaleX: 0, transformOrigin: 'left center' },
              { scaleX: 1, duration: AUTOPLAY_MS / 1000, ease: 'none' },
            );
          } else {
            gsap.set(bar, { scaleX: 0 });
          }
        }
      });
    },
    { scope: root, dependencies: [active, autoplay, inView, needle] },
  );

  function onTabKey(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? areas.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    open(next);
    const tabs = root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[((next % areas.length) + areas.length) % areas.length]?.focus();
  }

  return (
    <div ref={root} className="sk-explorer grid gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <label className="relative block">
          <span className="sr-only">{labels.searchLabel}</span>
          <Search
            size={18}
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              touched.current = true;
              setAutoplay(false);
              setQuery(event.target.value);
            }}
            placeholder={labels.searchPlaceholder}
            className="h-11 w-full rounded-pill border border-line-strong bg-surface pl-10 pr-4 text-body-sm text-ink placeholder:text-text-faint focus:border-brand focus:outline-none focus:shadow-[var(--ring)]"
          />
        </label>
        <p className="font-mono text-caption text-text-muted">{labels.total}</p>
        <div
          role="tablist"
          aria-label={labels.areas}
          aria-orientation="vertical"
          className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
        >
          {areas.map((area, index) => {
            const selected = index === active && !needle;
            return (
              <button
                key={area.key}
                type="button"
                role="tab"
                id={`${id}-tab-${area.key}`}
                aria-selected={selected}
                aria-controls={`${id}-panel-${area.key}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  setQuery('');
                  open(index);
                }}
                onKeyDown={(event) => onTabKey(event, index)}
                className={cn(
                  'relative shrink-0 overflow-hidden rounded-pill px-3.5 py-2 text-left text-body-sm font-semibold transition-[background-color,color] duration-150 ease-standard lg:rounded-md',
                  selected
                    ? 'bg-ink text-paper'
                    : 'bg-transparent text-ink-soft hover:bg-surface-2 hover:text-ink',
                )}
              >
                <span className="flex items-center justify-between gap-3">
                  {area.title}
                  <span
                    className={cn(
                      'font-mono text-caption tabular-nums',
                      selected ? 'text-paper/70' : 'text-text-faint',
                    )}
                  >
                    {area.rows.length}
                  </span>
                </span>
                {selected && (
                  <span
                    data-autobar
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-accent"
                  />
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            touched.current = true;
            setAutoplay((on) => !on);
          }}
          className="self-start text-caption font-semibold text-link hover:text-link-hover"
          aria-pressed={autoplay}
        >
          {autoplay ? labels.pause : labels.resume}
        </button>
      </div>

      <div className="min-w-0">
        {needle ? (
          <div
            role="region"
            aria-live="polite"
            className="rounded-card border border-line bg-paper p-5 sm:p-7"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-body font-bold text-ink">
                {results.length === 0
                  ? labels.noResults
                  : (results.length === 1 ? labels.matchesOne : labels.matchesOther).replace(
                      '{count}',
                      String(results.length),
                    )}
              </p>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-body-sm font-semibold text-link hover:text-link-hover"
              >
                {labels.clear}
              </button>
            </div>
            {results.length > 0 && (
              <ul className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
                {results.map(({ area, row }) => (
                  <li key={`${area.key}.${row.key}`} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => {
                        setQuery('');
                        open(areas.indexOf(area));
                      }}
                      className="text-left"
                    >
                      <span className="block font-mono text-overline uppercase tracking-wide text-text-muted">
                        {area.title}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm font-bold text-ink hover:text-brand">
                        {row.title}
                        {row.tier && (
                          <Badge tone="brand" variant="outline">
                            {row.tier}
                          </Badge>
                        )}
                        {row.soon && (
                          <Badge tone="info" variant="soft">
                            {labels.soon}
                          </Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block text-body-sm text-ink-soft">{row.body}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {areas.map((area, index) => {
          const shown = index === active && !needle;
          return (
            <section
              key={area.key}
              id={`${id}-panel-${area.key}`}
              data-panel={area.key}
              role="tabpanel"
              aria-labelledby={`${id}-tab-${area.key}`}
              hidden={!shown}
              className="rounded-card border border-line bg-paper p-5 sm:p-7"
            >
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <h3
                    id={`f-${area.key}`}
                    className="scroll-mt-24 text-h3 font-extrabold tracking-tight text-ink"
                  >
                    {area.title}
                  </h3>
                  <p className="mt-1 text-body-sm text-ink-soft">{area.lead}</p>
                </div>
                <span className="font-mono text-caption text-text-muted">
                  {(area.rows.length === 1 ? labels.matchesOne : labels.matchesOther).replace(
                    '{count}',
                    String(area.rows.length),
                  )}
                </span>
              </div>
              {area.shot && (
                <div className="mt-5">
                  <DeviceFrame shot={area.shot} alt={area.shotAlt} eager={index === 0} />
                </div>
              )}
              <ul className="mt-6 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                {area.rows.map((row) => (
                  <li key={row.key} data-row className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm font-bold text-ink">
                      {row.title}
                      {row.tier && (
                        <Badge tone="brand" variant="outline">
                          {row.tier}
                        </Badge>
                      )}
                      {row.soon && (
                        <Badge tone="info" variant="soft">
                          {labels.soon}
                        </Badge>
                      )}
                    </p>
                    <p className="mt-0.5 text-body-sm text-ink-soft">{row.body}</p>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
