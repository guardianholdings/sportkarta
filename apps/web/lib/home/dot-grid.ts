/**
 * The front page's dot-matrix Bulgaria (components/home/dot-map.tsx).
 *
 * ONE GRID, defined here and nowhere else: the SQL that counts facilities into
 * cells (lib/home/dots.ts) and the SVG that draws them both read it, so a dot
 * can never sit somewhere its count was not taken. A cell is an (i, j) pair —
 * column from the west edge, row from the north edge — its centre a longitude
 * and latitude, and its dot a point on a lattice `PITCH` units apart.
 *
 * Cells are square ON THE GROUND rather than in degrees: dx is dy stretched by
 * 1/cos φ at Bulgaria's middle latitude, so the country keeps its true shape
 * without a projection library (≈ 5.6 km a side). The extent is the
 * municipalities' own bounding box, a little padded; BULGARIA_BBOX in
 * lib/src/geo is the map's camera fence and is deliberately looser.
 *
 * Pure and client-safe: the hero's sport filter re-colours the same dots by
 * the same keys in the browser.
 */

const MID_LAT = 42.7;
const DY = 0.055;

export const DOT_GRID = {
  minLon: 22.33,
  maxLat: 44.24,
  dy: DY,
  dx: DY / Math.cos((MID_LAT * Math.PI) / 180),
  cols: 85,
  rows: 56,
} as const;

/** SVG user units between two neighbouring dots. */
export const PITCH = 10;

/** Radius of a dot with no free facility in its cell — the country's outline. */
export const EMPTY_RADIUS = 1.1;

export function cellKey(i: number, j: number): string {
  return `${i}-${j}`;
}

export function inGrid(i: number, j: number): boolean {
  return (
    Number.isInteger(i) &&
    Number.isInteger(j) &&
    i >= 0 &&
    j >= 0 &&
    i < DOT_GRID.cols &&
    j < DOT_GRID.rows
  );
}

/** The cell a coordinate falls in (the SQL does the same arithmetic). */
export function cellOf(lon: number, lat: number): { i: number; j: number } {
  return {
    i: Math.floor((lon - DOT_GRID.minLon) / DOT_GRID.dx),
    j: Math.floor((DOT_GRID.maxLat - lat) / DOT_GRID.dy),
  };
}

export function cellCenter(i: number, j: number): { lon: number; lat: number } {
  return {
    lon: DOT_GRID.minLon + (i + 0.5) * DOT_GRID.dx,
    lat: DOT_GRID.maxLat - (j + 0.5) * DOT_GRID.dy,
  };
}

/** Where a cell's dot is drawn, in SVG user units. */
export function dotPosition(i: number, j: number): { x: number; y: number } {
  return { x: i * PITCH + PITCH / 2, y: j * PITCH + PITCH / 2 };
}

export const VIEWBOX = `0 0 ${DOT_GRID.cols * PITCH} ${DOT_GRID.rows * PITCH}`;

/**
 * A dot grows with the log of its count and stops just short of touching its
 * neighbours: Sofia's centre holds hundreds of places and a linear scale would
 * make every village a speck.
 */
export function dotRadius(count: number): number {
  if (count <= 0) return EMPTY_RADIUS;
  return Math.min(4.6, 1.7 + 0.95 * Math.log2(count));
}

/** Colour step 1–5 (lightest → darkest green), read by the `sk-dot--tN` classes. */
export function dotTier(count: number): 1 | 2 | 3 | 4 | 5 {
  if (count >= 50) return 5;
  if (count >= 15) return 4;
  if (count >= 5) return 3;
  if (count >= 2) return 2;
  return 1;
}

/**
 * The full map opened on a cell. Zoom 12 is a few kilometres across — the
 * neighbourhood the dot stands for, not the country. The cell's centre is a
 * point on a 5 km lattice, never anyone's position.
 */
export function cellMapHref(i: number, j: number, sport: string | null): string {
  const { lon, lat } = cellCenter(i, j);
  const params = new URLSearchParams();
  if (sport) params.set('sport', sport);
  params.set('z', '12');
  params.set('lat', lat.toFixed(4));
  params.set('lng', lon.toFixed(4));
  return `/karta?${params.toString()}`;
}
