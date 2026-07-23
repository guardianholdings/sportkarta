import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import {
  formatRrule,
  parseRrule,
  parseWall,
  RecurrenceError,
  SOFIA_TZ,
  formatWall,
  type WallClock,
} from '@sportkarta/lib/recurrence';

import { SessionError, type SessionErrorCode } from './errors';

/**
 * Validation and normalisation for a session series — pure, so the rules are
 * testable without a database and identical on the create and the edit path.
 *
 * The database enforces all of this again (migration 0008). That is not
 * redundancy for its own sake: a constraint violation is a 500 with a Postgres
 * message, while these throw a slug the UI can translate into something an
 * organiser can act on.
 */

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
export const DURATION_MIN = 15;
export const DURATION_MAX = 480;
export const CAPACITY_MAX = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SKILL_LEVELS = ['any', 'beginner', 'intermediate', 'advanced'] as const;
const VISIBILITIES = ['public', 'unlisted'] as const;

export type SkillLevel = (typeof SKILL_LEVELS)[number];
export type Visibility = (typeof VISIBILITIES)[number];

export interface SessionInput {
  facilityId: string;
  sport: string;
  title: string;
  description?: string | null;
  /** Wall clock in Europe/Sofia: `YYYY-MM-DDTHH:MM`. Never an instant. */
  startsAtLocal: string;
  rrule?: string | null;
  durationMinutes: number;
  capacity?: number | null;
  skillLevel?: string;
  visibility?: string;
}

export interface NormalizedSession {
  facilityId: string;
  sport: string;
  title: string;
  description: string | null;
  startsAtLocal: string;
  timezone: string;
  /** Canonical rule text, or null for a one-off. */
  rrule: string | null;
  durationMinutes: number;
  capacity: number | null;
  skillLevel: SkillLevel;
  visibility: Visibility;
  /** Parsed DTSTART, so callers do not re-parse to check it is in the future. */
  dtstart: WallClock;
}

export function normalizeSession(input: SessionInput): NormalizedSession {
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (title === '') throw new SessionError('title_required');
  if (title.length > TITLE_MAX) throw new SessionError('title_too_long');

  const description = (input.description ?? '').trim();
  if (description.length > DESCRIPTION_MAX) throw new SessionError('description_too_long');

  if (!(CANONICAL_SPORTS as readonly string[]).includes(input.sport)) {
    throw new SessionError('invalid_sport');
  }

  // Checked here so a malformed id becomes a translatable slug rather than a
  // Postgres 22P02 surfacing as a 500.
  if (!UUID_RE.test(input.facilityId)) throw new SessionError('facility_not_found');

  const skillLevel = (input.skillLevel ?? 'any') as SkillLevel;
  if (!(SKILL_LEVELS as readonly string[]).includes(skillLevel)) {
    throw new SessionError('invalid_skill_level');
  }
  const visibility = (input.visibility ?? 'public') as Visibility;
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) {
    throw new SessionError('invalid_visibility');
  }

  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < DURATION_MIN ||
    input.durationMinutes > DURATION_MAX
  ) {
    throw new SessionError('invalid_duration');
  }

  const capacity = input.capacity ?? null;
  if (
    capacity !== null &&
    (!Number.isInteger(capacity) || capacity < 1 || capacity > CAPACITY_MAX)
  ) {
    throw new SessionError('invalid_capacity');
  }

  let dtstart: WallClock;
  try {
    dtstart = parseWall(input.startsAtLocal);
  } catch {
    throw new SessionError('invalid_start');
  }

  // The rule is parsed, not pattern-matched, and stored in the engine's own
  // canonical form — so what is in the column is exactly what the materializer
  // will expand, with no room for two spellings of the same rule.
  let rrule: string | null = null;
  const raw = (input.rrule ?? '').trim();
  if (raw !== '') {
    try {
      rrule = formatRrule(parseRrule(raw));
    } catch (error: unknown) {
      if (error instanceof RecurrenceError) throw new SessionError(error.code as SessionErrorCode);
      throw new SessionError('rrule_syntax');
    }
  }

  return {
    facilityId: input.facilityId,
    sport: input.sport,
    title,
    description: description === '' ? null : description,
    startsAtLocal: formatWall(dtstart),
    timezone: SOFIA_TZ,
    rrule,
    durationMinutes: input.durationMinutes,
    capacity,
    skillLevel,
    visibility,
    dtstart,
  };
}
