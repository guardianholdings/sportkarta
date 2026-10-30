import type { ClubSport } from './activities.js';

/**
 * Ranks and belts (wave G2, 0056) — a club's grading ladders: the closed
 * vocabularies and limits the office, the portal and the database share, and
 * the starting ladders a club may pick instead of typing every belt.
 *
 * What a client HOLDS and whether they are ready for the next exam are the
 * database's (club_member_rank_progress, derived from attendance); nothing
 * here decides them.
 */

/**
 * club_ranks_colour_known / _accent_known (0056): the belt palette. Each is a
 * CSS token (`--belt-<colour>` in app/design-tokens/colors.css), so a club
 * picks a colour and never types one.
 */
export const BELT_COLOURS = [
  'white',
  'grey',
  'yellow',
  'orange',
  'red',
  'green',
  'blue',
  'purple',
  'brown',
  'black',
] as const;
export type BeltColour = (typeof BELT_COLOURS)[number];

/** club_member_ranks_reason_known (0056): an exam, the coach's promotion, or held before. */
export const RANK_AWARD_REASONS = ['exam', 'promotion', 'prior'] as const;
export type RankAwardReason = (typeof RANK_AWARD_REASONS)[number];

export const LADDER_NAME_MAX = 80;
export const RANK_NAME_MAX = 60;
/** club_ranks_stripes_sane: a BJJ belt's degrees. */
export const RANK_STRIPES_MAX = 6;
export const RANK_ATTENDANCES_MAX = 1000;
export const RANK_MONTHS_MAX = 240;
/** club_ranks_stamp refuses the 41st. */
export const RANKS_PER_LADDER_MAX = 40;

export function isBeltColour(value: unknown): value is BeltColour {
  return typeof value === 'string' && (BELT_COLOURS as readonly string[]).includes(value);
}

export function isRankAwardReason(value: unknown): value is RankAwardReason {
  return typeof value === 'string' && (RANK_AWARD_REASONS as readonly string[]).includes(value);
}

export interface RankTemplateRank {
  /** i18n key under `ClubRanks.templates.<template>.ranks`. */
  key: string;
  colour: BeltColour;
  accent?: BeltColour;
  stripes?: number;
}

export interface RankTemplate {
  sport: ClubSport;
  ranks: readonly RankTemplateRank[];
}

/**
 * Starting ladders, lowest rank first. Their names live in messages/*.json
 * (`ClubRanks.templates.<template>.name` and `.ranks.<key>`), copied into the
 * club's own rows in both languages when the ladder is created — after that
 * they are the club's to rename. No template sets what a rank asks: clubs
 * differ, and the coach decides.
 */
export const RANK_TEMPLATES = {
  /** Judo: six kyu grades and the first dan. */
  judo: {
    sport: 'judo',
    ranks: [
      { key: 'white', colour: 'white' },
      { key: 'yellow', colour: 'yellow' },
      { key: 'orange', colour: 'orange' },
      { key: 'green', colour: 'green' },
      { key: 'blue', colour: 'blue' },
      { key: 'brown', colour: 'brown' },
      { key: 'black', colour: 'black' },
    ],
  },
  /** Brazilian jiu-jitsu, adults: the five belts (stripes are the club's to add). */
  bjj: {
    sport: 'bjj',
    ranks: [
      { key: 'white', colour: 'white' },
      { key: 'blue', colour: 'blue' },
      { key: 'purple', colour: 'purple' },
      { key: 'brown', colour: 'brown' },
      { key: 'black', colour: 'black' },
    ],
  },
  /** Taekwondo (WT): ten gup grades, the odd ones two-tone, and the first dan. */
  taekwondo: {
    sport: 'taekwondo',
    ranks: [
      { key: 'gup10', colour: 'white' },
      { key: 'gup9', colour: 'white', accent: 'yellow' },
      { key: 'gup8', colour: 'yellow' },
      { key: 'gup7', colour: 'yellow', accent: 'green' },
      { key: 'gup6', colour: 'green' },
      { key: 'gup5', colour: 'green', accent: 'blue' },
      { key: 'gup4', colour: 'blue' },
      { key: 'gup3', colour: 'blue', accent: 'red' },
      { key: 'gup2', colour: 'red' },
      { key: 'gup1', colour: 'red', accent: 'black' },
      { key: 'dan1', colour: 'black' },
    ],
  },
} as const satisfies Record<string, RankTemplate>;

export type RankTemplateKey = keyof typeof RANK_TEMPLATES;
export const RANK_TEMPLATE_KEYS = Object.keys(RANK_TEMPLATES) as RankTemplateKey[];

export function isRankTemplateKey(value: unknown): value is RankTemplateKey {
  return typeof value === 'string' && Object.hasOwn(RANK_TEMPLATES, value);
}
