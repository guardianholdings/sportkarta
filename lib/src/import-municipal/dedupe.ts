/**
 * Deciding whether an incoming municipal row is a NEW facility, a MATCH for an
 * existing one, or a CONFLICT a human must resolve (docs/ROADMAP.md §8, Stage
 * 6.3). Pure — the SQL that FINDS nearby candidates lives in db/src/import, and
 * this classifies what it returns, so the decision is testable without a
 * database and identical in the preview and at commit.
 *
 * THE BIAS IS DELIBERATE: a false CONFLICT is safe (a human reviews it), a
 * false MATCH silently rewrites the wrong facility. So the rule for an
 * automatic match is strict — one candidate, very close, and the names agree —
 * and everything ambiguous falls to CONFLICT rather than being guessed.
 *
 * A registry's coordinates are typically less precise than a phone's GPS, so
 * the radii here are wider than the 30 m the crowd add-facility flow uses to
 * reject an exact-spot duplicate: within CLOSE_M a same-named row is the same
 * place, out to CANDIDATE_M a same-named row is probably the same place logged
 * from a slightly different point, and anything else is for the operator.
 */

/** Auto-match only this close, and only with a matching name. */
export const CLOSE_M = 40;

/** Search this far for anything worth showing the operator as a possible match. */
export const CANDIDATE_M = 120;

export interface NearbyCandidate {
  facilityId: string;
  name: string | null;
  slug: string | null;
  /** Great-circle metres from the incoming point. */
  distanceM: number;
}

export type Classification =
  | { kind: 'new' }
  | { kind: 'match'; candidate: NearbyCandidate }
  | { kind: 'conflict'; reason: ConflictReason; candidates: NearbyCandidate[] };

export type ConflictReason = 'same_spot_different_name' | 'name_match_farther' | 'ambiguous';

/**
 * Normalise a facility name for comparison: lowercase, strip punctuation,
 * collapse whitespace. Two names that differ only in casing, spacing or a
 * trailing dash are the same registry entry logged twice.
 *
 * Deliberately NOT transliteration-folding — a Cyrillic and a Latin name for
 * the same place are far more likely to be two genuinely different records the
 * operator should see than a match worth making automatically. The bias again:
 * when unsure, conflict.
 */
export function normalizeName(name: string | null): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Do two names refer to the same place? Equal after normalisation, or one is a
 * token-subset of the other ("Спортен комплекс Раковски" vs "Раковски") — a
 * registry often carries a fuller name than the map's short label. A single
 * shared token is NOT enough: "Градски стадион" appears in every town.
 */
export function namesMatch(a: string | null, b: string | null): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === '' || nb === '') return false;
  if (na === nb) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size < 2) return false;
  return [...small].every((token) => large.has(token));
}

/**
 * Classify one incoming row against the facilities found near its point.
 * `candidates` must be sorted nearest-first (the caller's ORDER BY guarantees
 * it; this does not re-sort, so a caller that forgets gets a visible test
 * failure rather than a subtly wrong pick).
 */
export function classify(
  incomingName: string | null,
  candidates: readonly NearbyCandidate[],
): Classification {
  const inRange = candidates.filter((c) => c.distanceM <= CANDIDATE_M);
  if (inRange.length === 0) return { kind: 'new' };

  const veryClose = inRange.filter((c) => c.distanceM <= CLOSE_M);

  // More than one facility on top of the incoming point: which one the registry
  // means is genuinely unknown, so it is never guessed.
  if (veryClose.length > 1) {
    return { kind: 'conflict', reason: 'ambiguous', candidates: veryClose };
  }

  if (veryClose.length === 1) {
    const only = veryClose[0] as NearbyCandidate;
    if (namesMatch(incomingName, only.name)) {
      return { kind: 'match', candidate: only };
    }
    // Same spot, different name: probably the same place renamed, but a rename
    // is exactly the kind of change a human should confirm, not an importer.
    return { kind: 'conflict', reason: 'same_spot_different_name', candidates: [only] };
  }

  // Nothing within CLOSE_M, but something within CANDIDATE_M. Only a NAME match
  // makes it worth surfacing; a differently-named facility 80 m away is a
  // neighbour, not a duplicate, and the row is new.
  const namedFarther = inRange.filter((c) => namesMatch(incomingName, c.name));
  if (namedFarther.length === 0) return { kind: 'new' };
  return { kind: 'conflict', reason: 'name_match_farther', candidates: namedFarther };
}
