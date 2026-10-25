import {
  cellKey,
  dotPosition,
  dotRadius,
  dotTier,
  EMPTY_RADIUS,
  VIEWBOX,
} from '@/lib/home/dot-grid';

/**
 * The dot map's data as the server hands it to the client — flat arrays, not
 * an element tree, so the page carries the map once in compact form instead of
 * twice as markup (once rendered, once again inside the RSC payload).
 */
export interface DotMapData {
  /** Every cell inside the country with no free place, as one SVG path. */
  land: string;
  /** Lit cells as [i, j, count, municipality (−1 = none)] quadruples. */
  cells: number[];
  /** All-sports totals as [municipality, count] pairs. */
  municipalities: number[];
  /**
   * [municipality, display name, city-page slug, «Всички места във …» label].
   * The slug and label are null where no city page exists; the label is built
   * on the server, where the catalogue's в/във select can see the name.
   */
  places: [number, string, string | null, string | null][];
  /** Cells with a public session this week, as [i, j] pairs. */
  pulses: number[];
}

export interface LitCell {
  key: string;
  i: number;
  j: number;
  n: number;
  m: number;
}

/** Lit cells grouped by municipality, in a stable order. */
export function groupCells(cells: readonly number[]): Map<number, LitCell[]> {
  const groups = new Map<number, LitCell[]>();
  for (let k = 0; k + 3 < cells.length; k += 4) {
    const i = cells[k] ?? 0;
    const j = cells[k + 1] ?? 0;
    const cell = { key: cellKey(i, j), i, j, n: cells[k + 2] ?? 0, m: cells[k + 3] ?? -1 };
    const group = groups.get(cell.m);
    if (group) group.push(cell);
    else groups.set(cell.m, [cell]);
  }
  return groups;
}

/**
 * Bulgaria drawn in dots (lib/home/dot-grid.ts). Three layers, cheapest first:
 *  - the land: ONE path of zero-length round-capped strokes — ~2 000 dots for
 *    a few bytes each;
 *  - the places: a circle per lit cell, sized and coloured by its count, in a
 *    group per municipality so hovering can light a whole municipality;
 *  - the pulses: cells with a public session this week, in coral — the brand's
 *    colour for play, as green is the map's.
 *
 * `counts` is the chosen sport's layer (null = all sports): a cell missing
 * from it shrinks back into the land. No hooks — hero-map.tsx memoises it, so
 * moving the pointer never re-renders a thousand circles.
 */
export function DotMapSvg({
  land,
  groups,
  counts,
  pulses,
  title,
}: {
  land: string;
  groups: Map<number, LitCell[]>;
  counts: Map<string, number> | null;
  pulses: readonly number[];
  title: string;
}) {
  const rings: { key: string; x: number; y: number; delay: number }[] = [];
  for (let k = 0; k + 1 < pulses.length; k += 2) {
    const i = pulses[k] ?? 0;
    const j = pulses[k + 1] ?? 0;
    rings.push({ key: cellKey(i, j), ...dotPosition(i, j), delay: ((k / 2) % 6) * 400 });
  }

  return (
    <svg
      viewBox={VIEWBOX}
      className="sk-dotmap"
      role="img"
      aria-labelledby="home-dotmap-title"
      focusable="false"
    >
      <title id="home-dotmap-title">{title}</title>
      <path className="sk-dotmap__land" d={land} />
      {[...groups].map(([m, cells]) => (
        <g key={m} data-m={m}>
          {cells.map((cell) => {
            const n = counts ? (counts.get(cell.key) ?? 0) : cell.n;
            const { x, y } = dotPosition(cell.i, cell.j);
            return (
              <circle
                key={cell.key}
                data-k={cell.key}
                data-n={n}
                cx={x}
                cy={y}
                r={(n > 0 ? dotRadius(n) : EMPTY_RADIUS).toFixed(2)}
                className={n > 0 ? `sk-dot sk-dot--t${dotTier(n)}` : 'sk-dot sk-dot--off'}
              />
            );
          })}
        </g>
      ))}
      <g className="sk-dotmap__pulses" aria-hidden="true">
        {rings.map((ring) => (
          <g key={ring.key} transform={`translate(${ring.x} ${ring.y})`}>
            <circle
              className="sk-pulse__ring"
              r="3.2"
              style={{ animationDelay: `${ring.delay}ms` }}
            />
            <circle className="sk-pulse__core" r="3.2" />
          </g>
        ))}
      </g>
    </svg>
  );
}
