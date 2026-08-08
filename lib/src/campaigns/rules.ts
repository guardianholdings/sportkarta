import { PASSPORT_EVENT_KINDS, type PassportEventKind } from '../badges/index.js';
import { CANONICAL_SPORTS } from '../sports.js';

/**
 * Campaign scoring grammar (docs/ROADMAP.md §7, Stage 5.3).
 *
 * "CAMPAIGNS AS CONFIG" AND "ADMIN CRUD" ARE ONLY COMPATIBLE IF YOU ARE
 * PRECISE ABOUT WHICH PART IS CONFIG. Badges (5.1) are config in the strict
 * sense — a TypeScript array, developer-authored, no rows. A campaign cannot
 * be: an admin creates one from a browser without a deploy, so a campaign is a
 * row.
 *
 * What stays config is THIS document — the scoring rules, stored as JSONB
 * inside that row, validated here against a closed grammar and compiled to one
 * SQL aggregate in db/src/campaigns.ts. So:
 *
 *   creating a campaign        = filling in a form
 *   inventing a new KIND of    = extending this grammar, with a deploy and a
 *   scoring                      test
 *
 * The line matters because the alternative — a column per scoring knob — turns
 * every campaign idea into a migration, and the alternative to THAT (a free
 * expression language in the database) hands whoever can edit a campaign the
 * ability to run arbitrary logic against the ledger.
 *
 * VALIDATION IS NOT DECORATION HERE. This document arrives from a form, is
 * stored as JSONB (which the database cannot type-check), and is later
 * compiled into SQL that decides who wins a prize. Every field is checked on
 * the way in, and the compiler in db/ is allowed to assume a validated
 * document — that assumption is what keeps the SQL builder simple enough to
 * read.
 */

/** Ranked members, or ranked municipalities. See CAMPAIGN_LEADERBOARD_TYPES. */
export const CAMPAIGN_LEADERBOARD_TYPES = ['individual', 'city'] as const;
export type CampaignLeaderboardType = (typeof CAMPAIGN_LEADERBOARD_TYPES)[number];

/** Layout for the landing page. Closed set — a template is code, not content. */
export const CAMPAIGN_TEMPLATES = ['standard', 'sprint', 'city_race'] as const;
export type CampaignTemplate = (typeof CAMPAIGN_TEMPLATES)[number];

export const CAMPAIGN_STATUSES = ['draft', 'published', 'closed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export type CampaignScope =
  | { kind: 'national' }
  | { kind: 'city'; municipalityId: number }
  | { kind: 'quarter'; municipalityId: number; quarter: string };

export interface CampaignEventWeight {
  kind: PassportEventKind;
  /** Multiplies the COUNT of qualifying events, not the ledger's own points. */
  weight: number;
}

export interface CampaignRules {
  events: CampaignEventWeight[];
  /** Restrict to facilities carrying one of these sports. Absent = any sport. */
  sports?: string[];
  /**
   * Maximum score one member can bank in a single Sofia civil day.
   *
   * This is the anti-abuse knob, and it matters more here than anywhere else
   * in the product: a campaign is the first feature where gaming the ledger
   * wins a PRIZE. Without it a single day of bulk activity can carry a
   * month-long campaign.
   */
  perDayCap?: number;
}

/**
 * Below this many contributing members, an aggregate city row is SUPPRESSED.
 *
 * An aggregate board is safe for minors precisely because no individual is
 * named — but a municipality where one person contributed publishes that
 * person's score under a city label, which is the same disclosure with extra
 * steps. Five is a floor, not a calculation: it is small enough that real
 * cities still appear and large enough that no row is one person.
 */
export const CITY_BOARD_MIN_MEMBERS = 5;

/** Weights are small integers; the ceiling stops a typo minting a winner. */
export const MAX_EVENT_WEIGHT = 1000;
export const MAX_SPORTS_FILTER = 10;

export class CampaignRuleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CampaignRuleError';
  }
}

const CANONICAL_SPORT_SET = new Set<string>(CANONICAL_SPORTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Validate and NORMALISE a rules document.
 *
 * Normalisation is part of the contract, not a nicety: events come back in the
 * canonical PASSPORT_EVENT_KINDS order and sports in CANONICAL_SPORTS order, so
 * two admins who tick the same boxes in a different order store byte-identical
 * JSONB. That makes the stored document diffable and makes "did this campaign's
 * rules change?" answerable by comparison.
 */
export function validateCampaignRules(input: unknown): CampaignRules {
  if (!isRecord(input)) throw new CampaignRuleError('rules_not_an_object');

  const rawEvents = input.events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new CampaignRuleError('rules_no_events');
  }

  const byKind = new Map<PassportEventKind, number>();
  for (const entry of rawEvents) {
    if (!isRecord(entry)) throw new CampaignRuleError('rules_bad_event');
    const kind = entry.kind;
    if (typeof kind !== 'string' || !(PASSPORT_EVENT_KINDS as readonly string[]).includes(kind)) {
      throw new CampaignRuleError('rules_unknown_event');
    }
    const weight = positiveInteger(entry.weight);
    if (weight === null || weight > MAX_EVENT_WEIGHT) {
      throw new CampaignRuleError('rules_bad_weight');
    }
    // A repeated kind is ambiguous — which weight wins? Refuse rather than
    // silently keeping the last one, which is how a campaign ends up scoring
    // something nobody intended.
    if (byKind.has(kind as PassportEventKind)) throw new CampaignRuleError('rules_duplicate_event');
    byKind.set(kind as PassportEventKind, weight);
  }

  const events: CampaignEventWeight[] = PASSPORT_EVENT_KINDS.filter((kind) => byKind.has(kind)).map(
    (kind) => ({ kind, weight: byKind.get(kind) as number }),
  );

  const rules: CampaignRules = { events };

  if (input.sports !== undefined && input.sports !== null) {
    if (!Array.isArray(input.sports)) throw new CampaignRuleError('rules_bad_sports');
    const selected = new Set<string>();
    for (const sport of input.sports) {
      if (typeof sport !== 'string' || !CANONICAL_SPORT_SET.has(sport)) {
        throw new CampaignRuleError('rules_unknown_sport');
      }
      selected.add(sport);
    }
    if (selected.size === 0) throw new CampaignRuleError('rules_bad_sports');
    if (selected.size > MAX_SPORTS_FILTER) throw new CampaignRuleError('rules_too_many_sports');
    rules.sports = CANONICAL_SPORTS.filter((sport) => selected.has(sport));
  }

  if (input.perDayCap !== undefined && input.perDayCap !== null) {
    const cap = positiveInteger(input.perDayCap);
    if (cap === null) throw new CampaignRuleError('rules_bad_cap');
    // A cap below the heaviest event means even a single qualifying action is
    // clipped, which is always a mistake rather than a policy: the admin has
    // set a cap thinking in "actions" and written it in "points".
    const heaviest = Math.max(...events.map((event) => event.weight));
    if (cap < heaviest) throw new CampaignRuleError('rules_cap_below_weight');
    rules.perDayCap = cap;
  }

  return rules;
}

/** Scope from loose form values, validated. */
export function validateCampaignScope(
  kind: unknown,
  municipalityId: unknown,
  quarter: unknown,
): CampaignScope {
  if (kind === 'national') return { kind: 'national' };

  const id = positiveInteger(
    typeof municipalityId === 'string' ? Number(municipalityId) : municipalityId,
  );
  if (id === null) throw new CampaignRuleError('scope_needs_municipality');

  if (kind === 'city') return { kind: 'city', municipalityId: id };

  if (kind === 'quarter') {
    const name = typeof quarter === 'string' ? quarter.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new CampaignRuleError('scope_needs_quarter');
    if (name.length > 120) throw new CampaignRuleError('scope_quarter_too_long');
    return { kind: 'quarter', municipalityId: id, quarter: name };
  }

  throw new CampaignRuleError('scope_unknown');
}

export function isCampaignLeaderboardType(value: unknown): value is CampaignLeaderboardType {
  return (
    typeof value === 'string' && (CAMPAIGN_LEADERBOARD_TYPES as readonly string[]).includes(value)
  );
}

export function isCampaignTemplate(value: unknown): value is CampaignTemplate {
  return typeof value === 'string' && (CAMPAIGN_TEMPLATES as readonly string[]).includes(value);
}

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return typeof value === 'string' && (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

/**
 * URL slug for a campaign. Latin only and stable: it is the shareable link, so
 * it must survive being pasted into a Facebook post and a printed flyer.
 */
export const CAMPAIGN_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CAMPAIGN_SLUG_MAX = 60;

export function validateCampaignSlug(value: unknown): string {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!slug || slug.length > CAMPAIGN_SLUG_MAX) throw new CampaignRuleError('slug_invalid');
  if (!CAMPAIGN_SLUG_PATTERN.test(slug)) throw new CampaignRuleError('slug_invalid');
  return slug;
}
