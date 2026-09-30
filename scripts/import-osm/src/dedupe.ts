import { GEOMETRY_RANK, type OsmType } from './normalize.js';

/**
 * Cross-element duplicates: the same pitch or gym mapped twice in OSM — once
 * as a node, once as the way (or relation) outlining it. Each is a valid OSM
 * object with its own ref, so the (osm_type, osm_id) key never collides and
 * both reached the map: ~45 such pairs in production, 1–5 m apart (audit
 * finding 88).
 *
 * WHAT COUNTS. Two candidates of DIFFERENT element types whose centroids are
 * within {@link DUPLICATE_RADIUS_M} and which share at least one sport. Same
 * type never counts — node/node pairs are separate equipment (two ping-pong
 * tables, a row of fitness stations). No shared sport never counts, and a
 * sport-less candidate shares nothing, so it is never folded into another.
 *
 * WHAT IS DONE ABOUT IT — only for rows that do not exist yet. Dropping an
 * EXISTING row from the candidate set would not hide it: the importer reports
 * rows absent from the extract and never marks them gone, so it would merely
 * freeze a published duplicate. And which of two published rows a person has
 * visited, reported or hosted a session at is a question for a human. So:
 *   - a new candidate duplicating a row already in the database is not
 *     inserted (the existing row wins — never create a duplicate);
 *   - between two new candidates, the preferred one is inserted: polygon over
 *     point over line (GEOMETRY_RANK — the same order that already picks an
 *     area over its perimeter ring), then relation over way over node;
 *   - two rows that are BOTH already in the database are left alone and
 *     reported, for a moderator to decide.
 */
export const DUPLICATE_RADIUS_M = 5;

export interface DedupeInput {
  key: string;
  osmType: OsmType;
  geometryKind: string;
  sportTypes: string[];
  lon: number;
  lat: number;
  /** Already a row in the database. */
  existing: boolean;
}

export interface DuplicatePair {
  /** The kept side (for `existingPairs`, the preferred one of the two). */
  keep: string;
  drop: string;
  distanceM: number;
}

export interface DedupeResult {
  /** New candidates not to insert, each with the candidate it duplicates. */
  dropped: DuplicatePair[];
  /** Pairs of rows that are both already in the database — report only. */
  existingPairs: DuplicatePair[];
}

const TYPE_RANK: Record<OsmType, number> = { relation: 2, way: 1, node: 0 };

/** Positive when `a` is the better representative of the place than `b`. */
function compare(a: DedupeInput, b: DedupeInput): number {
  const byGeometry = (GEOMETRY_RANK[a.geometryKind] ?? 0) - (GEOMETRY_RANK[b.geometryKind] ?? 0);
  if (byGeometry !== 0) return byGeometry;
  const byType = TYPE_RANK[a.osmType] - TYPE_RANK[b.osmType];
  if (byType !== 0) return byType;
  // Deterministic across runs: the lower key wins a full tie.
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres. At 5 m the formula's error is irrelevant. */
export function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Grid cell of ~11 m × 8 m at Bulgarian latitudes: larger than the radius in
// both axes, so every pair within it lies in the same or an adjacent cell.
const CELL_DEG = 0.0001;

function cellKey(x: number, y: number): string {
  return `${String(x)}:${String(y)}`;
}

export function findDuplicates(inputs: DedupeInput[], radiusM = DUPLICATE_RADIUS_M): DedupeResult {
  const grid = new Map<string, number[]>();
  const cellOf = (c: DedupeInput): [number, number] => [
    Math.floor(c.lon / CELL_DEG),
    Math.floor(c.lat / CELL_DEG),
  ];
  inputs.forEach((c, i) => {
    const key = cellKey(...cellOf(c));
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });

  // Every duplicate relation, both directions, with its distance.
  const partners = new Map<number, { j: number; distanceM: number }[]>();
  const link = (i: number, j: number, distanceM: number): void => {
    const list = partners.get(i);
    if (list) list.push({ j, distanceM });
    else partners.set(i, [{ j, distanceM }]);
  };
  const existingPairs: DuplicatePair[] = [];

  inputs.forEach((a, i) => {
    const [cx, cy] = cellOf(a);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const j of grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
          if (j <= i) continue; // each unordered pair once
          const b = inputs[j] as DedupeInput;
          if (a.osmType === b.osmType) continue;
          if (!a.sportTypes.some((sport) => b.sportTypes.includes(sport))) continue;
          const distanceM = haversineM(a.lon, a.lat, b.lon, b.lat);
          if (distanceM > radiusM) continue;
          if (a.existing && b.existing) {
            const [keep, drop] = compare(a, b) >= 0 ? [a, b] : [b, a];
            existingPairs.push({ keep: keep.key, drop: drop.key, distanceM });
            continue;
          }
          link(i, j, distanceM);
          link(j, i, distanceM);
        }
      }
    }
  });

  // Greedy, best first: existing rows are kept unconditionally, then each new
  // candidate in preference order is kept only if nothing already kept
  // duplicates it. A candidate is therefore only ever dropped in favour of a
  // row that really ends up on the map — never in favour of another dropped
  // one, which could otherwise chain a separate object (a second table next
  // to the first) out of the import.
  const kept = new Set<number>();
  inputs.forEach((c, i) => {
    if (c.existing) kept.add(i);
  });
  const order = inputs
    .map((_, i) => i)
    .filter((i) => !(inputs[i] as DedupeInput).existing && partners.has(i))
    .sort((i, j) => compare(inputs[j] as DedupeInput, inputs[i] as DedupeInput));

  const dropped: DuplicatePair[] = [];
  for (const i of order) {
    const keptPartners = (partners.get(i) ?? []).filter((p) => kept.has(p.j));
    if (keptPartners.length === 0) {
      kept.add(i);
      continue;
    }
    // Report the best of the rows it duplicates (existing ones first).
    const best = keptPartners.reduce((x, y) => {
      const ex = (inputs[x.j] as DedupeInput).existing;
      const ey = (inputs[y.j] as DedupeInput).existing;
      if (ex !== ey) return ex ? x : y;
      return compare(inputs[x.j] as DedupeInput, inputs[y.j] as DedupeInput) >= 0 ? x : y;
    });
    dropped.push({
      keep: (inputs[best.j] as DedupeInput).key,
      drop: (inputs[i] as DedupeInput).key,
      distanceM: best.distanceM,
    });
  }

  const byDrop = (x: DuplicatePair, y: DuplicatePair): number =>
    x.drop.localeCompare(y.drop) || x.keep.localeCompare(y.keep);
  return { dropped: dropped.sort(byDrop), existingPairs: existingPairs.sort(byDrop) };
}
