'use client';

import { ArrowRight, MapPin, X } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { buttonVariants } from '@/components/ui/button';
import { chipClass } from '@/components/ui/chip';
import { Link } from '@/i18n/navigation';
import { sportVisual } from '@/lib/design/sport-visuals';
import { cellKey, cellMapHref, DOT_GRID, dotPosition, PITCH, VIEWBOX } from '@/lib/home/dot-grid';
// Type-only: erased from the client bundle, so the server module never ships.
import type { TopPlace } from '@/lib/home/places';
import { cn } from '@/lib/utils';
import type { CanonicalSport } from '@sportkarta/lib/sports';

import { DotMapSvg, groupCells, type DotMapData, type LitCell } from './dot-map';
import { Odometer } from './odometer';

export interface HeroChip {
  /** null = every sport. */
  sport: string | null;
  label: string;
  count: number;
  /** The words under the number: «безплатни места за баскетбол». */
  stat: string;
}

export interface HeroMapLabels {
  filter: string;
  showOnMap: string;
  topLabel: string;
  placesOne: string;
  placesOther: string;
  openHere: string;
  close: string;
  hint: string;
  loadError: string;
  attribution: string;
}

/** /api/home/dots — flat triples and pairs, to keep the payload small. */
interface LayerPayload {
  cells: number[];
  municipalities: number[];
  top: TopPlace[];
}

interface SportLayer {
  cells: Map<string, number>;
  municipalities: Map<number, number>;
  top: TopPlace[];
}

/**
 * What the hero SHOWS: a chip and its layer, set together and only once the
 * layer is in hand. Everything on screen — the dots, the number, the «most
 * places» links, the button to the map — derives from this one value, so a
 * slow or failed fetch can never pair one sport's links with another's data.
 */
interface Shown {
  index: number;
  /** null = the all-sports layer the server drew. */
  layer: SportLayer | null;
}

interface Focus {
  cell: LitCell;
  pinned: boolean;
}

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';

function pairs(flat: readonly number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let k = 0; k + 1 < flat.length; k += 2) map.set(flat[k] ?? -1, flat[k + 1] ?? 0);
  return map;
}

function toLayer(payload: LayerPayload): SportLayer {
  const cells = new Map<string, number>();
  for (let k = 0; k + 2 < payload.cells.length; k += 3) {
    cells.set(
      cellKey(payload.cells[k] ?? -1, payload.cells[k + 1] ?? -1),
      payload.cells[k + 2] ?? 0,
    );
  }
  return { cells, municipalities: pairs(payload.municipalities), top: payload.top };
}

function countLabel(count: number, locale: string, labels: HeroMapLabels): string {
  const tag = locale === 'en' ? 'en' : 'bg';
  const template =
    new Intl.PluralRules(tag).select(count) === 'one' ? labels.placesOne : labels.placesOther;
  return template.replace(
    '#',
    new Intl.NumberFormat(tag === 'en' ? 'en-GB' : 'bg-BG').format(count),
  );
}

/**
 * The live half of the hero: Bulgaria in dots (dot-map.tsx), explorable.
 *
 *  - Sport chips re-colour the same dots from /api/home/dots — a few kilobytes
 *    per sport, cached for the visit, with the server's number rolling over.
 *  - Pointing at the map lights the municipality under the pointer and names
 *    it; a tap or click pins a card with the full map of that area and the
 *    city's page. The hit test runs on the data, not the DOM, and snaps to the
 *    nearest lit dot within a cell and a half — the dots are a few pixels wide.
 *  - Everything a keyboard or screen-reader user needs is outside the canvas:
 *    the chips, the «most places» links and the button to the map.
 */
export function HeroMap({
  locale,
  data,
  title,
  chips,
  initialTop,
  cityPageMin,
  labels,
  legend,
}: {
  locale: string;
  data: DotMapData;
  title: string;
  chips: HeroChip[];
  initialTop: TopPlace[];
  /** A city (or city-and-sport) page exists from this many places up. */
  cityPageMin: number;
  labels: HeroMapLabels;
  legend: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef(new Map<string, SportLayer>());
  const requestRef = useRef(0);
  const [shown, setShown] = useState<Shown>({ index: 0, layer: null });
  /** A chip whose layer is still loading: pressed, but driving nothing else. */
  const [pending, setPending] = useState<number | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [failed, setFailed] = useState(false);

  const base = useMemo(() => {
    const groups = groupCells(data.cells);
    const byKey = new Map<string, LitCell>();
    for (const cells of groups.values()) for (const cell of cells) byKey.set(cell.key, cell);
    return {
      groups,
      byKey,
      totals: pairs(data.municipalities),
      places: new Map(
        data.places.map(([m, name, slug, cityLabel]) => [m, { name, slug, cityLabel }]),
      ),
    };
  }, [data]);

  const chip = chips[shown.index] ?? chips[0];
  const sport = chip?.sport ?? null;
  const counts = shown.layer?.cells ?? null;
  const top = shown.layer?.top ?? initialTop;
  const pressed = pending ?? shown.index;

  const cityHref = (slug: string, count: number) =>
    sport && count >= cityPageMin ? `/igrishta/${slug}/${sport}` : `/igrishta/${slug}`;

  // The thousand circles render only when the shown layer changes, never on hover.
  const svg = useMemo(
    () => (
      <DotMapSvg
        land={data.land}
        groups={base.groups}
        counts={counts}
        pulses={data.pulses}
        title={title}
      />
    ),
    [data.land, data.pulses, base.groups, counts, title],
  );

  async function choose(next: number) {
    const target = chips[next];
    if (!target || next === pressed) return;
    const request = ++requestRef.current;
    setFailed(false);
    setFocus(null);

    const cached = target.sport === null ? null : cacheRef.current.get(target.sport);
    if (target.sport === null || cached) {
      setPending(null);
      setShown({ index: next, layer: cached ?? null });
      return;
    }

    setPending(next);
    let layer: SportLayer;
    try {
      const response = await fetch(
        `/api/home/dots?sport=${encodeURIComponent(target.sport)}&locale=${locale}`,
      );
      if (!response.ok) throw new Error(String(response.status));
      layer = toLayer((await response.json()) as LayerPayload);
      cacheRef.current.set(target.sport, layer);
    } catch {
      // What is shown simply stays; only the press is undone.
      if (request === requestRef.current) {
        setPending(null);
        setFailed(true);
      }
      return;
    }
    if (request !== requestRef.current) return;
    setPending(null);
    setShown({ index: next, layer });
  }

  /** The lit dot nearest the pointer, within a cell and a half. */
  function hitTest(clientX: number, clientY: number): LitCell | null {
    const rect = rootRef.current?.querySelector('svg.sk-dotmap')?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * DOT_GRID.cols * PITCH;
    const y = ((clientY - rect.top) / rect.height) * DOT_GRID.rows * PITCH;
    const ci = Math.floor(x / PITCH);
    const cj = Math.floor(y / PITCH);
    let best: LitCell | null = null;
    let bestDistance = (1.6 * PITCH) ** 2;
    for (let di = -2; di <= 2; di += 1) {
      for (let dj = -2; dj <= 2; dj += 1) {
        const cell = base.byKey.get(cellKey(ci + di, cj + dj));
        if (!cell || (counts && !counts.has(cell.key))) continue;
        const centre = dotPosition(cell.i, cell.j);
        const distance = (centre.x - x) ** 2 + (centre.y - y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cell;
        }
      }
    }
    return best;
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' || focus?.pinned) return;
    const cell = hitTest(event.clientX, event.clientY);
    if (cell?.key === focus?.cell.key) return;
    setFocus(cell ? { cell, pinned: false } : null);
  }

  function onPointerLeave() {
    if (!focus?.pinned) setFocus(null);
  }

  function onClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest('[data-card]')) return;
    const cell = hitTest(event.clientX, event.clientY);
    setFocus(cell ? { cell, pinned: true } : null);
  }

  // Light the focused municipality; dim the rest of the country. The groups
  // carry no className of their own, so React never overwrites this one.
  const hot = focus && focus.cell.m !== -1 ? focus.cell.m : null;
  useEffect(() => {
    const map = rootRef.current?.querySelector('svg.sk-dotmap');
    if (!map) return;
    const group = hot === null ? null : map.querySelector(`g[data-m="${String(hot)}"]`);
    map.classList.toggle('has-hot', group !== null);
    group?.classList.add('is-hot');
    return () => {
      group?.classList.remove('is-hot');
    };
  }, [hot, svg]);

  // A pinned card closes on Escape and on a press anywhere outside the map.
  const pinned = focus?.pinned === true;
  useEffect(() => {
    if (!pinned) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocus(null);
    };
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setFocus(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [pinned]);

  // A cell no municipality could be named for (a border or coastal edge case)
  // reports its own count rather than a «— · 0» line.
  const place = focus ? base.places.get(focus.cell.m) : undefined;
  let focusCount = 0;
  if (focus) {
    if (place) {
      focusCount = shown.layer
        ? (shown.layer.municipalities.get(focus.cell.m) ?? 0)
        : (base.totals.get(focus.cell.m) ?? 0);
    } else {
      focusCount = counts ? (counts.get(focus.cell.key) ?? 0) : focus.cell.n;
    }
  }
  const left = focus ? ((focus.cell.i + 0.5) / DOT_GRID.cols) * 100 : 0;
  const topPct = focus ? ((focus.cell.j + 0.5) / DOT_GRID.rows) * 100 : 0;
  const ring = focus ? dotPosition(focus.cell.i, focus.cell.j) : null;
  const mapHref = sport ? `/karta?sport=${sport}` : '/karta';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <p aria-live="polite" className="min-w-0">
          <Odometer
            key={sport ?? 'all'}
            value={chip?.count ?? 0}
            locale={locale}
            className="font-display text-display-lg font-extrabold leading-none tracking-tight text-brand"
          />
          <span className="mt-1.5 block text-body-sm font-medium text-ink-soft">{chip?.stat}</span>
        </p>
        {legend}
      </div>

      <div
        ref={rootRef}
        className={cn('sk-dotmap-frame relative', pending !== null && 'is-busy')}
        aria-busy={pending !== null}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onClick={onClick}
      >
        {svg}
        <svg
          viewBox={VIEWBOX}
          className="pointer-events-none absolute inset-0 size-full"
          aria-hidden="true"
          focusable="false"
        >
          {ring && <circle className="sk-dotmap__focus" cx={ring.x} cy={ring.y} r="7.5" />}
        </svg>
        {focus && (
          // No dialog role: the card opens from a pointer only, takes no
          // focus, and everything on it is reachable outside the canvas.
          <div
            data-card
            className={cn(
              'absolute z-10 w-max max-w-64 rounded-card border border-line bg-surface p-3 text-left shadow-lg',
              // One translate per axis: two utilities on the same axis fight,
              // and the later one in the stylesheet wins.
              left < 22
                ? '-translate-x-3'
                : left > 78
                  ? '-translate-x-[calc(100%-0.75rem)]'
                  : '-translate-x-1/2',
              topPct < 38 ? 'translate-y-4' : '-translate-y-[calc(100%+1rem)]',
              !focus.pinned && 'pointer-events-none',
            )}
            style={{ left: `${left}%`, top: `${topPct}%` } as CSSProperties}
          >
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1">
                {place && (
                  <span className="block truncate text-body-sm font-bold text-ink">
                    {place.name}
                  </span>
                )}
                <span className="block font-mono text-caption tabular-nums text-brand">
                  {countLabel(focusCount, locale, labels)}
                </span>
              </p>
              {focus.pinned && (
                <button
                  type="button"
                  onClick={() => setFocus(null)}
                  aria-label={labels.close}
                  className="-m-1 grid size-8 shrink-0 place-items-center rounded-full text-ink-soft hover:bg-surface-2"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            {focus.pinned && (
              <div className="mt-2.5 flex flex-col gap-1.5">
                <Link
                  href={cellMapHref(focus.cell.i, focus.cell.j, sport)}
                  className={buttonVariants({ variant: 'primary', size: 'sm', block: true })}
                >
                  <MapPin size={16} />
                  {labels.openHere}
                </Link>
                {place?.slug && place.cityLabel && (
                  <Link
                    href={cityHref(place.slug, focusCount)}
                    className={buttonVariants({ variant: 'secondary', size: 'sm', block: true })}
                  >
                    {place.cityLabel}
                  </Link>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div
        role="group"
        aria-label={labels.filter}
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0"
      >
        {chips.map((item, k) => {
          const visual = item.sport ? sportVisual(item.sport as CanonicalSport) : null;
          const Icon = visual?.Icon;
          return (
            <button
              key={item.sport ?? 'all'}
              type="button"
              aria-pressed={k === pressed}
              onClick={() => void choose(k)}
              className={cn(chipClass({ selected: k === pressed }), 'shrink-0')}
              style={{ '--chip': visual?.color ?? 'var(--brand)' } as CSSProperties}
            >
              {Icon && <Icon size={16} aria-hidden="true" />}
              <span className="first-letter:uppercase">{item.label}</span>
            </button>
          );
        })}
      </div>

      {failed && (
        <p role="status" className="text-body-sm text-danger">
          {labels.loadError}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {top.length > 0 && (
          <p className="min-w-0 text-body-sm text-ink-soft">
            <span className="mr-1.5 font-semibold text-ink">{labels.topLabel}</span>
            {top.map((item, k) => (
              <span key={item.slug}>
                {k > 0 && <span aria-hidden="true"> · </span>}
                <Link
                  href={cityHref(item.slug, item.count)}
                  className="font-medium text-link hover:text-link-hover"
                >
                  {item.name}
                </Link>{' '}
                <span className="font-mono text-caption tabular-nums">{item.count}</span>
              </span>
            ))}
          </p>
        )}
        <Link href={mapHref} className={buttonVariants({ variant: 'primary' })}>
          {labels.showOnMap}
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </div>
      <p className="-mt-1 flex flex-wrap justify-between gap-x-4 gap-y-1 text-caption text-text-muted">
        <span className="hidden lg:inline">{labels.hint}</span>
        {/* The dots are OpenStreetMap data: attribution on every map view,
            linked to the licence as the OSMF guidelines ask. */}
        <a
          href={OSM_COPYRIGHT}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-link"
        >
          {labels.attribution}
        </a>
      </p>
    </div>
  );
}
