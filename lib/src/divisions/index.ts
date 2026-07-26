import { bucketKeyFor, previousBucketKey, type BucketKey } from '../badges/streaks.js';
import { SOFIA_TZ } from '../recurrence/index.js';

/**
 * Weekly divisions («дивизии») — docs/ENGAGEMENT.md B2, docs/ENGAGEMENT-IMPLEMENTATION.md
 * phase 9.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE. One national ladder tells almost everybody
 * the same thing forever: you are #4,318, and you will be #4,318 next week too.
 * For a platform whose addressable population is a country where most adults do
 * no sport at all, that is the bottom of the board talking to nearly all of its
 * members. A division turns it into "you are 6th, and 7th promotes" — a
 * position that moves, in a field small enough to see.
 *
 * WHAT IS RANKED: points earned inside the civil-Sofia week, from
 * `points_ledger`. Operator decision 2026-07-26. Three reasons, and the third is
 * the one that matters:
 *
 *  1. The ledger already covers BOTH halves of the product — contributions
 *     (`facility_added`, `facility_verified`, `condition_reported`) and
 *     attendance (`session_attended`, written only for a QR-verified check-in by
 *     `play_session_checkins_only_qr_scores`). A division that ranked check-ins
 *     alone would be empty at launch, because session volume barely exists yet.
 *  2. The ledger was designed not to be gameable BEFORE anything ranked it —
 *     one award per facility added, per person per facility verified, per person
 *     per facility per Sofia day for conditions — so the strongest incentive
 *     this product has ever created lands on a surface already hardened.
 *  3. It is the same unit /klasirane ranks, so a member is never shown two
 *     numbers that disagree about what their week was worth.
 *
 * THIS MODULE IS PURE. It takes standings and returns assignments; it knows
 * nothing about SQL, consent or the clock beyond a `now` it is handed. That
 * matters because the alternative — deciding promotion inside the query that
 * computes it — is how a rule ends up stated in four places and enforced in
 * none.
 *
 * WHO IS ELIGIBLE IS NOT DECIDED HERE. Membership is gated by
 * `leaderboard_eligible_members` in db/src/divisions.ts, twice: at assignment
 * and again at display. This module never sees an account that has not opted in.
 */

/**
 * How many members share a division.
 *
 * Thirty (operator decision 2026-07-26), which is also Duolingo's number. Small
 * enough that a member can read the whole field and locate themselves in it,
 * large enough that one very active week does not decide the table.
 */
export const DIVISION_SIZE = 30;

/** Top N promote a tier. */
export const DIVISION_PROMOTE = 7;

/** Bottom M relegate a tier. */
export const DIVISION_RELEGATE = 5;

/**
 * Below this many assignable members, divisions do not run AT ALL.
 *
 * Not a display rule — the rollover writes nothing, so there is no ladder to
 * render and `/klasirane` keeps the national board as its default. Two reasons.
 * A "division" of three names three people beside each other in a ranking, which
 * is the k-anonymity problem `CITY_BOARD_MIN_MEMBERS` exists to avoid on the
 * city boards. And an empty feature must look ABSENT rather than broken — the
 * same discipline `AdSlot` and the Local Legend crest already follow.
 */
export const DIVISION_MIN_MEMBERS = 10;

/**
 * How recently a member must have scored to be assigned a place.
 *
 * A ladder padded with dormant accounts is not a ladder: it hands every active
 * member a top-seven finish for turning up once, and it fills the visible field
 * with rows that will never move. Four weeks is the shortest window that
 * survives a holiday.
 *
 * Leaving is not a punishment and re-entry is not a reset — an absent member's
 * tier is remembered by their LAST assignment (see `tierFor`), so someone who
 * misses August comes back where they left off.
 */
export const DIVISION_ACTIVE_WEEKS = 4;

/**
 * The five tiers, entry first.
 *
 * Bulgarian mountains ordered by the height of their highest summit (operator
 * decision 2026-07-26) — Голям Перелик 2191 m, Черни връх 2290 m, Ботев 2376 m,
 * Вихрен 2914 m, Мусала 2925 m. The ladder therefore has a real, checkable
 * ordering that a member can verify against a map, which is the same standard
 * the rest of the product holds itself to.
 *
 * WHY NOT NUMBERS. «Дивизия 1» is a rank wearing a name, and a member sitting in
 * «Дивизия 7» has been told their position in the whole population — which is
 * the single thing divisions exist to stop saying (ENGAGEMENT §1.3, and the C7
 * framing rule that `Division` copy is gated by).
 *
 * SLUGS ONLY HERE. The Bulgarian names live in `messages/*.json` under
 * `Division.tier.*`, like every other string in the product.
 */
export const DIVISION_TIERS = [
  'rodopi',
  'vitosha',
  'stara_planina',
  'pirin',
  'rila',
] as const;

export type DivisionTier = (typeof DIVISION_TIERS)[number];

/** 1-based tier number, as stored. `rodopi` is 1; `rila` is `DIVISION_TIERS.length`. */
export const DIVISION_TIER_COUNT = DIVISION_TIERS.length;

/** The tier a member starts in, and the one relegation cannot fall below. */
export const DIVISION_ENTRY_TIER = 1;

/** Tier number → slug. Out-of-range numbers clamp rather than throw: a tier is display. */
export function tierSlug(tier: number): DivisionTier {
  const index = Math.min(Math.max(Math.trunc(tier), 1), DIVISION_TIER_COUNT) - 1;
  return DIVISION_TIERS[index] ?? DIVISION_TIERS[0];
}

/** Slug → tier number, or null for anything not in the catalogue. */
export function tierNumber(slug: string): number | null {
  const index = DIVISION_TIERS.indexOf(slug as DivisionTier);
  return index === -1 ? null : index + 1;
}

/**
 * What happens to a member at the end of the week.
 *
 * `hold` is the common answer and is deliberately not called anything else:
 * seven of thirty go up and five go down, so eighteen members finish a week
 * having simply stayed where they are. A vocabulary that named that outcome
 * "failed to promote" would be the demoralisation this whole mechanic was built
 * to remove, re-introduced in a string.
 */
export type DivisionZone = 'promote' | 'hold' | 'relegate';

export interface DivisionPlace {
  /** Competition rank within the group: ties share a rank, and the next rank skips. */
  rank: number;
  /** Points earned inside the week. Zero is a real, common value. */
  score: number;
}

export interface ZoneOptions {
  /** Members in the group. Defaults to a full division; a balanced group may be smaller. */
  size?: number;
  /** Tier the member is currently in, so the top tier cannot promote and the entry tier cannot relegate. */
  tier?: number;
}

/**
 * How many promote and how many relegate in a group of `size`.
 *
 * THE PRODUCT DECISION IS A PROPORTION, NOT A COUNT. Seven of thirty up and five
 * of thirty down is "roughly a quarter rises, roughly a sixth falls, and the
 * majority stay put"; the integers 7 and 5 are that proportion evaluated at
 * thirty. So a smaller group scales, and at exactly `DIVISION_SIZE` it returns
 * the operator's numbers unchanged.
 *
 * THE BUG THIS CLOSES. Applying 7 and 5 literally to a group of eight makes the
 * two zones OVERLAP — ranks 1..7 promote, ranks 4..8 relegate — and whichever
 * test runs first silently wins. Seven of eight members would have been promoted
 * out of a group that was supposed to be a competition. `planDivisions` now
 * balances group sizes so a group that small should never form, but a zone rule
 * that is only correct because of how its caller happens to partition is not a
 * rule. `floor(size * 7/30) + floor(size * 5/30) <= 0.4 * size`, so the bands are
 * disjoint at every size and a hold band always survives.
 */
export function zoneCounts(size: number): { promote: number; relegate: number } {
  const members = Math.max(Math.trunc(size), 0);
  return {
    promote: Math.floor((members * DIVISION_PROMOTE) / DIVISION_SIZE),
    relegate: Math.floor((members * DIVISION_RELEGATE) / DIVISION_SIZE),
  };
}

/**
 * The zone a place falls in.
 *
 * INACTIVITY PROTECTION IS HERE, and it is one line: a member who scored nothing
 * holds. This is what ENGAGEMENT B2 means by the phrase, and stating it in the
 * pure core rather than in the query is the difference between a rule and a
 * habit.
 *
 * Read it as the promise it is. A member who did not play this week is not
 * punished for it — they are exactly where they were. The alternative sends a
 * relegation notice to somebody who was ill, or away, or simply busy, which is
 * the loss-pressure loop §3 rejects, aimed at the members least able to absorb
 * it. It also removes the perverse incentive to scrape together a token
 * contribution on a Sunday night purely to avoid a demotion.
 *
 * The cost is real and accepted: a group where nobody scored is a group where
 * nobody moves, and a mostly-dormant group can stall. `DIVISION_ACTIVE_WEEKS`
 * is what stops that becoming permanent — a member who stops scoring stops
 * being assigned, and the group re-forms around the people who are actually
 * there.
 *
 * The two ends of the ladder are terminal by construction rather than by
 * caller discipline: `rila` cannot promote and `rodopi` cannot relegate, so no
 * screen ever has to explain a promotion that did not happen.
 */
export function zoneFor(place: DivisionPlace, options: ZoneOptions = {}): DivisionZone {
  const size = options.size ?? DIVISION_SIZE;
  const tier = options.tier ?? DIVISION_ENTRY_TIER;
  const { promote, relegate } = zoneCounts(size);

  // Inactivity protection. Before anything else, because it outranks position:
  // last place on zero is still `hold`.
  if (place.score <= 0) return 'hold';

  if (place.rank <= promote) {
    return tier >= DIVISION_TIER_COUNT ? 'hold' : 'promote';
  }
  // Counted from the BOTTOM of the ACTUAL group, not of a notional thirty.
  if (place.rank > size - relegate) {
    return tier <= DIVISION_ENTRY_TIER ? 'hold' : 'relegate';
  }
  return 'hold';
}

/**
 * A ranked group split into consecutive runs of the same zone.
 *
 * Lives here rather than in the ladder component because this is where the
 * ladder's one real bug was. The component originally recomputed the bands
 * itself and, at the entry tier, tinted the bottom rows as a relegation zone on
 * a ladder where relegation cannot happen — while suppressing the heading,
 * because announcing it would have been untrue. The result was a recessed band
 * whose only carrier was colour, saying something false.
 *
 * Delegating to `zoneFor` fixes it at the root: both ends of the ladder are
 * already terminal there, so at the entry tier no row IS a relegation row and
 * there is nothing to tint or explain. Keeping the split here means the fix has
 * a test rather than a screenshot.
 *
 * Rows must already be in rank order; runs are consecutive, so a caller cannot
 * accidentally render three separate promotion bands.
 */
export function divisionSections<T extends DivisionPlace>(
  rows: readonly T[],
  options: ZoneOptions = {},
): { zone: DivisionZone; rows: T[] }[] {
  const sections: { zone: DivisionZone; rows: T[] }[] = [];
  for (const row of rows) {
    const zone = zoneFor(row, options);
    const last = sections.at(-1);
    if (last && last.zone === zone) last.rows.push(row);
    else sections.push({ zone, rows: [row] });
  }
  return sections;
}

/** The tier a member moves to, given where they were and how they finished. */
export function nextTier(tier: number, zone: DivisionZone): number {
  const delta = zone === 'promote' ? 1 : zone === 'relegate' ? -1 : 0;
  return Math.min(Math.max(tier + delta, DIVISION_ENTRY_TIER), DIVISION_TIER_COUNT);
}

/**
 * A member as the rollover sees them: who they are, where they were, and how
 * their last week went.
 *
 * `previousTier` is null for someone who has never been assigned — a new member,
 * or the very first week the ladder ever runs. `place` is null when they were
 * not in a group last week, which is the same population plus anyone who fell
 * out through inactivity and has now come back.
 */
export interface DivisionCandidate {
  userId: string;
  previousTier: number | null;
  place: DivisionPlace | null;
  /** Group size they finished in, so a short group relegates proportionally. */
  previousSize?: number;
  /**
   * Ordering seed for the new week's groups — total points over the recent
   * window. Used only to keep a group's members of SIMILAR activity; it is never
   * shown and never scored.
   */
  recentScore: number;
}

/**
 * Where a member lands for the coming week.
 *
 * `zone` is what happened to them in the week that just closed, and is null for
 * a member who was not in a group — there is nothing to report, and rendering
 * "held" for someone who has never played would be a claim about a week they
 * were not in.
 */
export interface DivisionAssignment {
  userId: string;
  tier: number;
  /** Which group within the tier, 1-based. */
  ordinal: number;
  zone: DivisionZone | null;
}

/**
 * The tier a candidate belongs in for the coming week.
 *
 * A member with no history enters at the bottom. A member who was away keeps the
 * tier they last held: their absence already cost them the weeks they were not
 * scoring, and relegating them on top of that is charging twice for one thing.
 */
export function tierFor(candidate: DivisionCandidate): number {
  const previous = candidate.previousTier;
  if (previous === null) return DIVISION_ENTRY_TIER;
  if (!candidate.place) return Math.min(Math.max(previous, DIVISION_ENTRY_TIER), DIVISION_TIER_COUNT);
  return nextTier(previous, zoneFor(candidate.place, {
    size: candidate.previousSize ?? DIVISION_SIZE,
    tier: previous,
  }));
}

export interface PlanOptions {
  size?: number;
  minMembers?: number;
}

/**
 * The whole rollover, as a pure function: candidates in, assignments out.
 *
 * Returns an EMPTY array below the floor. That is the floor's entire
 * implementation — no group rows are written, so there is no ladder, so
 * `/klasirane` renders none. A caller cannot accidentally opt out of it by
 * forgetting a check, because there is nothing to forget: the plan is simply
 * empty.
 *
 * WITHIN A TIER, groups are BALANCED rather than filled-then-remainder, and
 * sliced contiguously from a list ordered by recent activity so that one group's
 * members are of similar activity — B2's actual promise.
 *
 * Balance is not tidiness. Filling greedily, a tier of 65 produces 30, 30 and 5,
 * and the five-member group is a "division" whose every member is within one
 * good week of both zones at once; it is also, because the list is sorted, made
 * up of the least active members — the people this mechanic exists to keep, put
 * in the most volatile field on the ladder. Balanced, the same tier produces 22,
 * 22 and 21. `zoneCounts` makes a small group safe; this makes one rare.
 *
 * DETERMINISTIC BY CONSTRUCTION. Ties in `recentScore` break on `userId`, so
 * re-running the job for the same week produces byte-identical assignments —
 * which is what makes the write idempotent rather than merely retry-safe.
 */
export function planDivisions(
  candidates: readonly DivisionCandidate[],
  options: PlanOptions = {},
): DivisionAssignment[] {
  const size = Math.max(options.size ?? DIVISION_SIZE, 1);
  const minMembers = options.minMembers ?? DIVISION_MIN_MEMBERS;
  if (candidates.length < minMembers) return [];

  const byTier = new Map<number, DivisionCandidate[]>();
  for (const candidate of candidates) {
    const tier = tierFor(candidate);
    const bucket = byTier.get(tier);
    if (bucket) bucket.push(candidate);
    else byTier.set(tier, [candidate]);
  }

  const assignments: DivisionAssignment[] = [];
  for (const [tier, members] of [...byTier.entries()].sort(([a], [b]) => a - b)) {
    members.sort((a, b) =>
      b.recentScore - a.recentScore || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
    // Balanced: `groups` groups differing in size by at most one, the larger
    // ones first, each a contiguous slice of the activity-ordered list.
    const groups = Math.max(Math.ceil(members.length / size), 1);
    const base = Math.floor(members.length / groups);
    const wide = members.length % groups;
    let cursor = 0;
    for (let ordinal = 1; ordinal <= groups; ordinal += 1) {
      const take = base + (ordinal <= wide ? 1 : 0);
      for (const candidate of members.slice(cursor, cursor + take)) {
        assignments.push({
          userId: candidate.userId,
          tier,
          ordinal,
          zone: candidate.place
            ? zoneFor(candidate.place, {
                size: candidate.previousSize ?? DIVISION_SIZE,
                tier: candidate.previousTier ?? DIVISION_ENTRY_TIER,
              })
            : null,
        });
      }
      cursor += take;
    }
  }
  return assignments;
}

/**
 * The Monday that starts the week now in progress.
 *
 * Delegates to `bucketKeyFor` — the ONE place in this codebase an instant is
 * allowed to become a calendar position — so a division week, a streak week and
 * the digest's week can never disagree about when Monday began. A local
 * `new Date()` truncation here would be right about 51 weeks a year and wrong on
 * the two DST transitions, in the evenings, which is when amateur sport happens.
 */
export function divisionWeekStart(now: Date = new Date(), timeZone: string = SOFIA_TZ): BucketKey {
  return bucketKeyFor(now, 'week', timeZone);
}

/** The Monday of the week that just closed — the one a rollover scores. */
export function closedWeekStart(now: Date = new Date(), timeZone: string = SOFIA_TZ): BucketKey {
  return previousBucketKey(divisionWeekStart(now, timeZone), 'week');
}
