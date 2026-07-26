import { describe, expect, it } from 'vitest';

import {
  DISTANCE_SPORTS,
  EARLIEST_TRAINING,
  evidenceFor,
  formatDuration,
  MAX_DISTANCE_M,
  MAX_DURATION_S,
  MIN_DURATION_S,
  normalizeTraining,
  parseDuration,
  TRAINING_EVIDENCE,
  TRAINING_SOURCES,
  trainingWeek,
  usesDistance,
  type TrainingInput,
} from './index.js';

const NOW = new Date('2026-07-26T12:00:00Z');

const input = (over: Partial<TrainingInput> = {}): TrainingInput => ({
  sport: 'running',
  startedAt: new Date('2026-07-26T06:30:00Z'),
  durationS: 45 * 60,
  ...over,
});

const problems = (over: Partial<TrainingInput> = {}) => {
  const result = normalizeTraining(input(over), NOW);
  return result.ok ? [] : result.problems;
};

describe('the vocabulary', () => {
  it('names every source and every evidence tier', () => {
    expect(TRAINING_SOURCES).toContain('manual');
    expect(TRAINING_SOURCES).toContain('strava');
    expect(TRAINING_SOURCES).toContain('garmin');
    expect(TRAINING_SOURCES).toContain('apple_health');
    // TWO tiers. A `qr_verified` label was drafted and removed before 0027
    // shipped because nothing could grant it, and an enum value cannot be
    // dropped once it exists.
    expect(TRAINING_EVIDENCE).toEqual(['self_reported', 'connected_app']);
  });

  /**
   * The tier a source produces is EXACT, not a ceiling: manual is always
   * self-reported and an import is always connected_app. Pinned in the database
   * too (`training_logs_evidence_matches_source`), because an earlier draft of
   * that CHECK let any importer assert a higher tier by passing a nicer string.
   */
  it('maps each source to exactly one tier', () => {
    expect(evidenceFor('manual')).toBe('self_reported');
    for (const source of TRAINING_SOURCES.filter((s) => s !== 'manual')) {
      expect(evidenceFor(source), source).toBe('connected_app');
    }
  });

  it('marks distance sports and only those', () => {
    expect(usesDistance('running')).toBe(true);
    expect(usesDistance('cycling')).toBe(true);
    expect(usesDistance('climbing')).toBe(false);
    expect(usesDistance('football')).toBe(false);
    expect(DISTANCE_SPORTS.every((sport) => usesDistance(sport))).toBe(true);
  });
});

describe('normalizeTraining', () => {
  it('accepts an ordinary run and stores the civil Sofia day', () => {
    const result = normalizeTraining(input(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sport).toBe('running');
    expect(result.value.sofiaDay).toBe('2026-07-26');
    expect(result.value.evidence).toBe('self_reported');
    expect(result.value.source).toBe('manual');
  });

  /**
   * 22:30Z in summer is already the NEXT day in Sofia. Getting this wrong moves
   * evening training — which is most of it — into the wrong day, and every
   * per-day board and streak inherits the error.
   */
  it('reads a late-evening instant as the next Sofia day', () => {
    const late = normalizeTraining(
      input({ startedAt: new Date('2026-07-26T21:30:00Z') }),
      new Date('2026-07-27T12:00:00Z'),
    );
    expect(late.ok).toBe(true);
    if (late.ok) expect(late.value.sofiaDay).toBe('2026-07-27');
  });

  it('rejects a sport outside the canonical vocabulary', () => {
    expect(problems({ sport: 'quidditch' })).toContain('sport_unknown');
  });

  it('bounds the duration at both ends', () => {
    expect(problems({ durationS: MIN_DURATION_S - 1 })).toContain('duration_out_of_range');
    expect(problems({ durationS: MAX_DURATION_S + 1 })).toContain('duration_out_of_range');
    expect(problems({ durationS: MIN_DURATION_S })).toEqual([]);
  });

  it('bounds the distance', () => {
    expect(problems({ distanceM: -1 })).toContain('distance_out_of_range');
    expect(problems({ distanceM: MAX_DISTANCE_M + 1 })).toContain('distance_out_of_range');
    expect(problems({ distanceM: 10_000 })).toEqual([]);
  });

  it('refuses a training dated in the future or before the platform existed', () => {
    expect(problems({ startedAt: new Date('2027-01-01T00:00:00Z') })).toContain(
      'started_at_future',
    );
    expect(problems({ startedAt: new Date(EARLIEST_TRAINING.getTime() - 1000) })).toContain(
      'started_at_too_old',
    );
  });

  it('allows a little clock skew, because phones are wrong', () => {
    expect(problems({ startedAt: new Date(NOW.getTime() + 60_000) })).toEqual([]);
  });

  /**
   * The dedupe key and the source must agree, or a re-sync cannot be made
   * idempotent — an import with no external id inserts again every single sync.
   */
  it('requires an external id for an import and forbids one on a manual entry', () => {
    expect(problems({ source: 'strava' })).toContain('external_id_missing');
    expect(problems({ source: 'manual', externalId: 'abc' })).toContain('external_id_on_manual');
    expect(problems({ source: 'strava', externalId: 'abc' })).toEqual([]);
  });

  it('reports EVERY problem at once, not just the first', () => {
    const found = problems({ sport: 'quidditch', durationS: 1, distanceM: -5 });
    expect(found).toContain('sport_unknown');
    expect(found).toContain('duration_out_of_range');
    expect(found).toContain('distance_out_of_range');
  });

  it('trims a note away to null rather than storing whitespace', () => {
    const result = normalizeTraining(input({ note: '   ' }), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.note).toBeNull();
  });

  /**
   * The whole point of the split tables: nothing a caller passes can put a
   * heart rate or a coordinate on the row every board reads.
   */
  it('produces no health or location field beyond a facility and a municipality', () => {
    const result = normalizeTraining(input({ facilityId: 'f1', municipalityId: 7 }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      'distanceM',
      'durationS',
      'elevationM',
      'evidence',
      'externalId',
      'facilityId',
      'municipalityId',
      'note',
      'sofiaDay',
      'source',
      'sport',
      'startedAt',
    ]);
  });
});

describe('parseDuration', () => {
  it('reads a clock and bare minutes', () => {
    expect(parseDuration('1:30')).toBe(5400);
    expect(parseDuration('0:45')).toBe(2700);
    expect(parseDuration('45')).toBe(2700);
  });

  it('returns null on anything else, rather than guessing', () => {
    for (const raw of ['', 'abc', '1:60', '1:5', '-3', '1.5']) {
      expect(parseDuration(raw), raw).toBeNull();
    }
  });

  it('round-trips through formatDuration', () => {
    for (const raw of ['0:45', '1:30', '12:00']) {
      expect(formatDuration(parseDuration(raw) ?? 0)).toBe(raw.replace(/^0(\d):/, '$1:'));
    }
  });
});

describe('trainingWeek', () => {
  it('is the same Monday the streaks and divisions use', () => {
    expect(trainingWeek(new Date('2026-07-22T10:00:00Z'))).toBe('2026-07-20');
    // 21:30Z Sunday is already Monday in Sofia — the new week's first cell.
    expect(trainingWeek(new Date('2026-07-19T21:30:00Z'))).toBe('2026-07-20');
  });
});
