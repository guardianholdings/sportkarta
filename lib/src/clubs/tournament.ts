/**
 * Tournaments (wave D2): the draw, the standings and the ratings — pure, so
 * the office, the public results page and the tests read one definition.
 *
 *   * SINGLE ELIMINATION — the bracket is the next power of two; the standard
 *     seeding (1 meets the lowest seed, 1 and 2 meet only in the final) puts
 *     the byes against the top seeds, so a first-round match never has two.
 *     The winner of match (round r, slot s) goes to (r + 1, ⌊s / 2⌋), on the
 *     A side when s is even.
 *   * ROUND ROBIN — the circle method: everybody meets everybody once; with an
 *     odd field one entrant rests each round.
 *   * STANDINGS — 3 points a win, 1 a draw; then score difference, then score
 *     for, then the seed. A walkover counts as a win for the standings.
 *   * RATINGS — an Elo fold over played matches in the order they were played,
 *     from 1500 with K = 32: DERIVED on every read, never stored, so a
 *     corrected result corrects every rating after it. A walkover moves no
 *     rating (nobody played).
 */

export const TOURNAMENT_FORMATS = ['single_elimination', 'round_robin'] as const;
export type TournamentFormat = (typeof TOURNAMENT_FORMATS)[number];

/** club_tournament_matches_status_known (0054). */
export const MATCH_STATUSES = ['pending', 'played', 'walkover', 'bye'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** A field this small or large is refused: a draw for one, or a schedule nobody plays. */
export const TOURNAMENT_ENTRANTS_MIN = 2;
export const TOURNAMENT_ENTRANTS_MAX = 128;
export const MATCH_SCORE_MAX = 1000;

export const ELO_START = 1500;
export const ELO_K = 32;

/** A match of a fresh draw: entrants are indexes into the seeded list; null is a bye or "to come". */
export interface DrawMatch {
  round: number;
  slot: number;
  a: number | null;
  b: number | null;
}

/** The standard seeding positions of a bracket of `size` (a power of two): 1, size, … */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const next: number[] = [];
    const span = order.length * 2 + 1;
    for (const seed of order) next.push(seed, span - seed);
    order = next;
  }
  return order.slice(0, size);
}

/** The smallest power of two that holds `entrants`. */
export function bracketSize(entrants: number): number {
  let size = 2;
  while (size < entrants) size *= 2;
  return size;
}

/**
 * A single-elimination draw for `entrants` seeded players (index 0 = seed 1):
 * every match of every round, the first round filled, later rounds empty.
 */
export function singleEliminationDraw(entrants: number): DrawMatch[] {
  if (entrants < TOURNAMENT_ENTRANTS_MIN || entrants > TOURNAMENT_ENTRANTS_MAX) {
    throw new RangeError('tournament: field size');
  }
  const size = bracketSize(entrants);
  const order = seedOrder(size);
  const matches: DrawMatch[] = [];
  for (let slot = 0; slot < size / 2; slot += 1) {
    const seedA = order[slot * 2] as number;
    const seedB = order[slot * 2 + 1] as number;
    matches.push({
      round: 1,
      slot,
      a: seedA <= entrants ? seedA - 1 : null,
      b: seedB <= entrants ? seedB - 1 : null,
    });
  }
  let inRound = size / 4;
  for (let round = 2; inRound >= 1; round += 1, inRound /= 2) {
    for (let slot = 0; slot < inRound; slot += 1) matches.push({ round, slot, a: null, b: null });
  }
  return matches;
}

/** Where the winner of (round, slot) goes next in a single-elimination draw. */
export function nextMatch(
  round: number,
  slot: number,
): { round: number; slot: number; side: 'a' | 'b' } {
  return { round: round + 1, slot: Math.floor(slot / 2), side: slot % 2 === 0 ? 'a' : 'b' };
}

/** How many rounds a single-elimination draw of `entrants` has. */
export function eliminationRounds(entrants: number): number {
  return Math.round(Math.log2(bracketSize(entrants)));
}

/** A round-robin schedule (the circle method): every pair once, rounds of disjoint pairs. */
export function roundRobinDraw(entrants: number): DrawMatch[] {
  if (entrants < TOURNAMENT_ENTRANTS_MIN || entrants > TOURNAMENT_ENTRANTS_MAX) {
    throw new RangeError('tournament: field size');
  }
  const field: (number | null)[] = Array.from({ length: entrants }, (_, i) => i);
  if (field.length % 2 === 1) field.push(null);
  const n = field.length;
  const matches: DrawMatch[] = [];
  let ring = field.slice(1);
  for (let round = 1; round < n; round += 1) {
    const line = [field[0] ?? null, ...ring];
    let slot = 0;
    for (let i = 0; i < n / 2; i += 1) {
      const a = line[i] ?? null;
      const b = line[n - 1 - i] ?? null;
      if (a === null || b === null) continue;
      matches.push({ round, slot, a: Math.min(a, b), b: Math.max(a, b) });
      slot += 1;
    }
    ring = [ring[ring.length - 1] ?? null, ...ring.slice(0, -1)];
  }
  return matches;
}

/**
 * Each drawn entrant's seed (1-based), read back from the stored matches: the
 * draw is recomputed for the field it was made for and laid over the rows —
 * round one of an elimination (byes included) and every round-robin match
 * name their entrants by draw position. So an entrant keeps their number when
 * they withdraw, and somebody confirmed after the draw is no entrant at all.
 * Empty when the rows are not a draw this module made.
 */
export function drawnSeeds(
  format: TournamentFormat,
  matches: readonly { round: number; slot: number; a: string | null; b: string | null }[],
): Map<string, number> {
  const field = new Set<string>();
  for (const match of matches) {
    if (format === 'single_elimination' && match.round !== 1) continue;
    if (match.a !== null) field.add(match.a);
    if (match.b !== null) field.add(match.b);
  }
  const seeds = new Map<string, number>();
  if (field.size < TOURNAMENT_ENTRANTS_MIN || field.size > TOURNAMENT_ENTRANTS_MAX) return seeds;
  const draw =
    format === 'single_elimination'
      ? singleEliminationDraw(field.size)
      : roundRobinDraw(field.size);
  const at = new Map(draw.map((m) => [`${String(m.round)}:${String(m.slot)}`, m]));
  for (const match of matches) {
    const drawn = at.get(`${String(match.round)}:${String(match.slot)}`);
    if (!drawn) continue;
    if (match.a !== null && drawn.a !== null) seeds.set(match.a, drawn.a + 1);
    if (match.b !== null && drawn.b !== null) seeds.set(match.b, drawn.b + 1);
  }
  return seeds.size === field.size ? seeds : new Map();
}

export interface PlayedMatch {
  a: string | null;
  b: string | null;
  scoreA: number | null;
  scoreB: number | null;
  status: MatchStatus;
  /** The walkover's winner; for a played match it follows from the score. */
  winner: string | null;
}

/** The winner of a played match by its score, or null for a draw. */
export function scoreWinner(
  match: Pick<PlayedMatch, 'a' | 'b' | 'scoreA' | 'scoreB'>,
): string | null {
  if (match.scoreA === null || match.scoreB === null || match.scoreA === match.scoreB) return null;
  return match.scoreA > match.scoreB ? match.a : match.b;
}

export interface Standing {
  entrant: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  scoreFor: number;
  scoreAgainst: number;
  points: number;
}

/**
 * The table of a round robin: 3 points a win, 1 a draw. Ties by score
 * difference, then score for, then the entrant's seed (their order in
 * `entrants`). A walkover is a win (no score); a bye is not a match.
 */
export function standings(
  entrants: readonly string[],
  matches: readonly PlayedMatch[],
): Standing[] {
  const rows = new Map<string, Standing>(
    entrants.map((entrant) => [
      entrant,
      { entrant, played: 0, won: 0, drawn: 0, lost: 0, scoreFor: 0, scoreAgainst: 0, points: 0 },
    ]),
  );
  for (const match of matches) {
    if (match.a === null || match.b === null) continue;
    const a = rows.get(match.a);
    const b = rows.get(match.b);
    if (!a || !b) continue;
    if (match.status === 'walkover' && match.winner) {
      const [win, loss] = match.winner === match.a ? [a, b] : [b, a];
      win.played += 1;
      loss.played += 1;
      win.won += 1;
      loss.lost += 1;
      win.points += 3;
      continue;
    }
    if (match.status !== 'played' || match.scoreA === null || match.scoreB === null) continue;
    a.played += 1;
    b.played += 1;
    a.scoreFor += match.scoreA;
    a.scoreAgainst += match.scoreB;
    b.scoreFor += match.scoreB;
    b.scoreAgainst += match.scoreA;
    if (match.scoreA === match.scoreB) {
      a.drawn += 1;
      b.drawn += 1;
      a.points += 1;
      b.points += 1;
    } else {
      const [win, loss] = match.scoreA > match.scoreB ? [a, b] : [b, a];
      win.won += 1;
      loss.lost += 1;
      win.points += 3;
    }
  }
  const seed = new Map(entrants.map((entrant, i) => [entrant, i]));
  return [...rows.values()].sort(
    (x, y) =>
      y.points - x.points ||
      y.scoreFor - y.scoreAgainst - (x.scoreFor - x.scoreAgainst) ||
      y.scoreFor - x.scoreFor ||
      (seed.get(x.entrant) ?? 0) - (seed.get(y.entrant) ?? 0),
  );
}

/** What A was expected to score against B (Elo). */
export function eloExpected(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * Ratings from played matches, folded in the order given (the order they
 * were played): from ELO_START, K = ELO_K, rounded on the way out only. A
 * walkover, a bye and an unscored match move nothing.
 */
export function eloRatings(matches: readonly PlayedMatch[]): Map<string, number> {
  const ratings = new Map<string, number>();
  const get = (id: string) => ratings.get(id) ?? ELO_START;
  for (const match of matches) {
    if (match.status !== 'played' || match.a === null || match.b === null) continue;
    if (match.scoreA === null || match.scoreB === null) continue;
    const ra = get(match.a);
    const rb = get(match.b);
    const actual = match.scoreA === match.scoreB ? 0.5 : match.scoreA > match.scoreB ? 1 : 0;
    const expected = eloExpected(ra, rb);
    ratings.set(match.a, ra + ELO_K * (actual - expected));
    ratings.set(match.b, rb + ELO_K * (expected - actual));
  }
  return new Map([...ratings].map(([id, rating]) => [id, Math.round(rating)]));
}

/** How an entrant is shown in public: their name only with their own consent. */
export function publicEntrantName(
  entrant: { name: string; namePublic: boolean; number: number },
  anonymous: (number: number) => string,
): string {
  return entrant.namePublic ? entrant.name : anonymous(entrant.number);
}
