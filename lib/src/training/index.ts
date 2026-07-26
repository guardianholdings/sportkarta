import { bucketKeyFor, type BucketKey } from '../badges/streaks.js';
import { SOFIA_TZ } from '../recurrence/index.js';
import { CANONICAL_SPORTS, type CanonicalSport } from '../sports.js';

/**
 * Personal training logs — the record of somebody doing sport, whether or not
 * anyone organised it.
 *
 * WHY THIS EXISTS. Everything the product could previously say about a member
 * came from two places: contributions to the map (`points_ledger`) and
 * attendance at an organised session (`play_session_checkins`). Neither is
 * participation. A member who runs four times a week and never edits the map is
 * invisible; the `/klasirane` sport filter, which looks like it answers "who
 * plays football", actually answers "who edited football pitches". This is the
 * missing dataset.
 *
 * IT DOES NOT AWARD POINTS, and that is an operator decision of 2026-07-26
 * rather than an omission. `points_ledger` is contribution-scoped and was
 * hardened against farming BEFORE anything ranked it — one award per facility
 * added, per person per facility verified, per person per facility per Sofia day
 * for conditions. A self-reported number cannot be given the same standing
 * without handing the strongest incentive in the product to whoever is willing
 * to type the largest number. Training therefore has its OWN board in its OWN
 * unit, and a competition that wants to score it later can do so through the
 * campaign rules grammar without merging the two economies.
 *
 * EVIDENCE IS STRUCTURAL, not advisory. Migration 0014 already established the
 * principle for check-ins: a row may score only when `method = 'qr'`, by CHECK,
 * because `self` is a button somebody tapped and `organizer` is somebody
 * vouching. The same tiering is carried here in `evidence`, pinned by a CHECK,
 * so that when a competition eventually reads these rows it can require a tier
 * rather than trusting the caller to have thought about it.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY. No heart rate, no calories, no route:
 * those live in separate, consent-gated tables (`training_metrics`,
 * `training_routes`) precisely so that this table — the one every board,
 * division and campaign reads — can never expose them, and so that withdrawing
 * consent deletes them without destroying a member's training history.
 */

/** Where a log came from. `manual` is a person typing; everything else is an import. */
export const TRAINING_SOURCES = [
  'manual',
  'strava',
  'garmin',
  'apple_health',
  'google_fit',
  'polar',
  'suunto',
  'other',
] as const;

export type TrainingSource = (typeof TRAINING_SOURCES)[number];

/**
 * How much the row can be trusted, weakest first.
 *
 * `self_reported`  — a person typed it. Fine for a personal history, and for a
 *                    board that counts turning up; never sufficient on its own
 *                    for a prize.
 * `connected_app`  — imported from a device or service the member connected.
 *                    Stronger, because it was recorded by something other than
 *                    the person claiming it — but still not proof: a phone can
 *                    be driven along a route, which is the Strava/Kim Flint
 *                    precedent docs/ENGAGEMENT.md §3 cites as a rejected shape.
 *
 * A third `qr_verified` tier — a training tied to a scanned session QR, the tier
 * `play_session_checkins_only_qr_scores` calls evidence — was drafted and
 * REMOVED before 0027 shipped. Nothing could produce it: there is no source for
 * the check-in path and `evidenceFor` never returned it, so it would have been a
 * permanent enum value (Postgres has no DROP VALUE) that silently returned an
 * empty board to any prize surface that asked for it. It returns when something
 * can actually grant it, together with the source that does.
 */
export const TRAINING_EVIDENCE = ['self_reported', 'connected_app'] as const;

export type TrainingEvidence = (typeof TRAINING_EVIDENCE)[number];

/**
 * The evidence a source produces.
 *
 * A manual entry is self-reported and cannot be anything else; an import is
 * `connected_app` and cannot be anything else. Pinned by
 * `training_logs_evidence_matches_source` in migration 0027, so an importer
 * cannot promote its own rows by passing a nicer string — the application is
 * not the layer this rule rests on.
 */
export function evidenceFor(source: TrainingSource): TrainingEvidence {
  return source === 'manual' ? 'self_reported' : 'connected_app';
}

/** One second. A log shorter than this is a mis-tap, not a training. */
export const MIN_DURATION_S = 60;

/**
 * Twenty-four hours. Bounded in the database as well as here, because these
 * rows can be edited by their owner and an unbounded number would otherwise sit
 * on a public board forever.
 */
export const MAX_DURATION_S = 24 * 60 * 60;

/** 1000 km — beyond any single human training session, generous for cycling. */
export const MAX_DISTANCE_M = 1_000_000;

/** Everest is 8 849 m; 30 000 m of gain in one session is not a thing. */
export const MAX_ELEVATION_M = 30_000;

export const MAX_NOTE_LENGTH = 500;

/**
 * Sports where a distance is meaningful.
 *
 * Not a restriction — a member may log distance for anything — but the form
 * asks for it only here, and a per-sport distance board would only ever be
 * honest for these. Climbing, football and gym work are measured in time and
 * turning up, which is also the framing the product prefers.
 */
export const DISTANCE_SPORTS: readonly CanonicalSport[] = [
  'athletics',
  'cycling',
  'hiking',
  'running',
  'swimming',
  'bmx',
  'ice_skating',
  'skateboard',
] as const;

export function usesDistance(sport: string): boolean {
  return (DISTANCE_SPORTS as readonly string[]).includes(sport);
}

const SPORT_SET = new Set<string>(CANONICAL_SPORTS);

/** The earliest instant a log may claim. Before this the platform did not exist. */
export const EARLIEST_TRAINING = new Date('2020-01-01T00:00:00Z');

/** How far into the future a log may be dated — clock skew only, never planning. */
export const FUTURE_SKEW_MS = 6 * 60 * 60 * 1000;

export interface TrainingInput {
  sport: string;
  startedAt: Date;
  durationS: number;
  distanceM?: number | null;
  elevationM?: number | null;
  facilityId?: string | null;
  municipalityId?: number | null;
  source?: TrainingSource;
  externalId?: string | null;
  note?: string | null;
}

export interface NormalizedTraining {
  sport: CanonicalSport;
  startedAt: Date;
  /** The civil Sofia day, `YYYY-MM-DD`. Stored, never re-derived in SQL. */
  sofiaDay: BucketKey;
  durationS: number;
  distanceM: number | null;
  elevationM: number | null;
  facilityId: string | null;
  municipalityId: number | null;
  source: TrainingSource;
  externalId: string | null;
  evidence: TrainingEvidence;
  note: string | null;
}

export type TrainingProblem =
  | 'sport_unknown'
  | 'duration_out_of_range'
  | 'distance_out_of_range'
  | 'elevation_out_of_range'
  | 'started_at_invalid'
  | 'started_at_future'
  | 'started_at_too_old'
  | 'note_too_long'
  | 'external_id_on_manual'
  | 'external_id_missing';

export type TrainingResult =
  | { ok: true; value: NormalizedTraining }
  | { ok: false; problems: TrainingProblem[] };

/**
 * Validate and normalise one log. Pure — takes `now` so the future check is
 * testable without a clock.
 *
 * EVERY problem is returned, not just the first: a member filling in a form
 * should be told everything that is wrong in one pass, and an importer should be
 * able to log a complete reason for skipping a row.
 *
 * The `sofiaDay` is computed HERE, through `bucketKeyFor` — the one place in
 * this codebase an instant becomes a calendar position — and stored. Deriving it
 * in SQL with `timezone('Europe/Sofia', started_at)` would be STABLE rather than
 * IMMUTABLE, so Postgres could not index it, and every per-day board would
 * degrade into a sequential scan of the whole table.
 */
export function normalizeTraining(
  input: TrainingInput,
  now: Date = new Date(),
  timeZone: string = SOFIA_TZ,
): TrainingResult {
  const problems: TrainingProblem[] = [];

  if (!SPORT_SET.has(input.sport)) problems.push('sport_unknown');

  const startedAt = input.startedAt;
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
    problems.push('started_at_invalid');
  } else {
    if (startedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) problems.push('started_at_future');
    if (startedAt.getTime() < EARLIEST_TRAINING.getTime()) problems.push('started_at_too_old');
  }

  const durationS = Math.trunc(input.durationS);
  if (!Number.isFinite(durationS) || durationS < MIN_DURATION_S || durationS > MAX_DURATION_S) {
    problems.push('duration_out_of_range');
  }

  const distanceM =
    input.distanceM === undefined || input.distanceM === null ? null : Math.trunc(input.distanceM);
  if (distanceM !== null && (!Number.isFinite(distanceM) || distanceM < 0 || distanceM > MAX_DISTANCE_M)) {
    problems.push('distance_out_of_range');
  }

  const elevationM =
    input.elevationM === undefined || input.elevationM === null
      ? null
      : Math.trunc(input.elevationM);
  if (
    elevationM !== null &&
    (!Number.isFinite(elevationM) || elevationM < 0 || elevationM > MAX_ELEVATION_M)
  ) {
    problems.push('elevation_out_of_range');
  }

  const note = input.note?.trim() ? input.note.trim() : null;
  if (note !== null && note.length > MAX_NOTE_LENGTH) problems.push('note_too_long');

  const source = input.source ?? 'manual';
  const externalId = input.externalId?.trim() ? input.externalId.trim() : null;
  // The dedupe key and the source have to agree, or a re-sync cannot be made
  // idempotent: a manual row carrying somebody's Strava id would collide with
  // the real import, and an import with no id would insert again every sync.
  if (source === 'manual' && externalId !== null) problems.push('external_id_on_manual');
  if (source !== 'manual' && externalId === null) problems.push('external_id_missing');

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    value: {
      sport: input.sport as CanonicalSport,
      startedAt,
      sofiaDay: bucketKeyFor(startedAt, 'day', timeZone),
      durationS,
      distanceM,
      elevationM,
      facilityId: input.facilityId ?? null,
      municipalityId: input.municipalityId ?? null,
      source,
      externalId,
      evidence: evidenceFor(source),
      note,
    },
  };
}

/**
 * `HH:MM` or minutes, to seconds.
 *
 * The form takes a duration the way a person says one. Returns null rather than
 * throwing, so the caller reports it alongside every other problem.
 */
export function parseDuration(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(text);
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60;
  if (!/^\d{1,5}$/.test(text)) return null;
  return Number(text) * 60;
}

/** Seconds back to `H:MM`, for a form that is being re-rendered after an error. */
export function formatDuration(seconds: number): string {
  const total = Math.max(Math.trunc(seconds), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${String(hours)}:${String(minutes).padStart(2, '0')}`;
}

/**
 * The civil Sofia week a training belongs to.
 *
 * Delegates to the same `bucketKeyFor` the streaks, the divisions and the digest
 * use, so a training week and a division week are the same week by construction.
 */
export function trainingWeek(at: Date, timeZone: string = SOFIA_TZ): BucketKey {
  return bucketKeyFor(at, 'week', timeZone);
}
