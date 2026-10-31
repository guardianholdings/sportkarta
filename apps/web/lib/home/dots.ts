import { getDb, publicFacilityVisible, sql, type SQL } from '@sportkarta/db';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';

import { DOT_GRID as G, inGrid } from './dot-grid';
import { homeCached } from './memo';

/**
 * What the front page's dot map counts (lib/home/dot-grid.ts draws it).
 *
 * THE SAME SET THE MAP OPENS ON: facilities the public map shows
 * (publicFacilityVisible — the paid-venue switches obeyed by construction) with
 * free access, the map's default filter. So the headline number, the dots and
 * «Покажете на картата» agree with what the next screen shows. A sport narrows
 * the set exactly as the map's sport chip does (`sport_types &&`).
 *
 * Aggregates only — a count per ~5.6 km cell and per municipality. No row,
 * name or coordinate leaves this module, and the cells are a fixed lattice, so
 * nothing here locates a facility more precisely than the map already does.
 */

const SPORTS = new Set<string>(CANONICAL_SPORTS);

/** A cell inside Bulgaria: the municipality whose polygon holds its centre. */
export interface MaskCell {
  i: number;
  j: number;
  m: number;
}

export interface CountCell {
  i: number;
  j: number;
  n: number;
  /** The municipality most of the cell's facilities belong to. */
  m: number | null;
}

export interface DotLayer {
  total: number;
  cells: CountCell[];
  /** Per-municipality totals, as [municipalityId, count] pairs. */
  municipalities: [number, number][];
}

export interface GamePulses {
  /** Upcoming public sessions in the next seven days. */
  total: number;
  cells: { i: number; j: number; n: number }[];
}

/** A canonical sport slug, or null for "every sport". */
export function dotSport(raw: string | null | undefined): string | null {
  return raw && SPORTS.has(raw) && raw !== 'multi' ? raw : null;
}

const CELL_I = sql`floor((ST_X(f.geom) - ${G.minLon}::float8) / ${G.dx}::float8)::int`;
const CELL_J = sql`floor((${G.maxLat}::float8 - ST_Y(f.geom)) / ${G.dy}::float8)::int`;

function sportClause(sport: string | null): SQL {
  return sport ? sql`AND f.sport_types && ARRAY[${sport}]::text[]` : sql``;
}

/**
 * Grid cells whose centre lies in Bulgaria. The point-in-polygon join over 265
 * municipality outlines is the one slow query here (≈ 1.5 s), and its answer
 * changes only with a boundary re-import — so a day per process.
 */
export function dotMask(): Promise<MaskCell[]> {
  return homeCached('dots:mask', 24 * 60 * 60_000, async () => {
    const result = await getDb().execute(sql`
      WITH grid AS (
        SELECT i, j,
               ST_SetSRID(ST_MakePoint(${G.minLon}::float8 + (i + 0.5) * ${G.dx}::float8,
                                       ${G.maxLat}::float8 - (j + 0.5) * ${G.dy}::float8), 4326) AS pt
          FROM generate_series(0, ${G.cols - 1}::int) AS i,
               generate_series(0, ${G.rows - 1}::int) AS j
      )
      SELECT g.i, g.j, m.id AS m
        FROM grid g
        JOIN municipalities m ON ST_Contains(m.geom, g.pt)
    `);
    return result.rows.map((row) => ({ i: Number(row.i), j: Number(row.j), m: Number(row.m) }));
  });
}

export function dotLayer(sport: string | null): Promise<DotLayer> {
  return homeCached(`dots:layer:${sport ?? '*'}`, 10 * 60_000, async () => {
    const db = getDb();
    const [cells, municipalities] = await Promise.all([
      db.execute(sql`
        SELECT ${CELL_I} AS i, ${CELL_J} AS j, count(*)::int AS n,
               mode() WITHIN GROUP (ORDER BY f.municipality_id) AS m
          FROM facilities f
         WHERE ${publicFacilityVisible} AND f.access = 'free' ${sportClause(sport)}
         GROUP BY 1, 2
      `),
      db.execute(sql`
        SELECT f.municipality_id AS m, count(*)::int AS n
          FROM facilities f
         WHERE ${publicFacilityVisible} AND f.access = 'free' ${sportClause(sport)}
           AND f.municipality_id IS NOT NULL
         GROUP BY 1
      `),
    ]);
    const counted = cells.rows
      .map((row) => ({
        i: Number(row.i),
        j: Number(row.j),
        n: Number(row.n),
        m: row.m === null || row.m === undefined ? null : Number(row.m),
      }))
      .filter((cell) => inGrid(cell.i, cell.j));
    return {
      total: counted.reduce((sum, cell) => sum + cell.n, 0),
      cells: counted,
      municipalities: municipalities.rows.map((row) => [Number(row.m), Number(row.n)]),
    };
  });
}

/**
 * Where something is on this week: the facilities of public, uncancelled
 * sessions in the next seven days, as cells. The same visibility rule as
 * /igri plus the public-map predicate, so a pulse never marks a place the map
 * would not show.
 */
export function gamePulses(): Promise<GamePulses> {
  return homeCached('dots:pulses', 5 * 60_000, async () => {
    const result = await getDb().execute(sql`
      SELECT ${CELL_I} AS i, ${CELL_J} AS j, count(*)::int AS n
        FROM play_session_occurrences o
        JOIN play_sessions s ON s.id = o.session_id
        JOIN facilities f ON f.id = s.facility_id
       WHERE s.visibility = 'public'
         AND o.status <> 'cancelled'
         AND o.starts_at > now()
         AND o.starts_at < now() + interval '7 days'
         AND ${publicFacilityVisible}
       GROUP BY 1, 2
    `);
    const cells = result.rows
      .map((row) => ({ i: Number(row.i), j: Number(row.j), n: Number(row.n) }))
      .filter((cell) => inGrid(cell.i, cell.j));
    return { total: cells.reduce((sum, cell) => sum + cell.n, 0), cells };
  });
}
