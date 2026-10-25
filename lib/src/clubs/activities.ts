import { CANONICAL_SPORTS, type CanonicalSport } from '../sports.js';

/**
 * What a club class can be about.
 *
 * The map's CANONICAL_SPORTS describe what a public facility is FOR (a
 * football pitch, a climbing wall). A gym's timetable speaks a finer language —
 * yoga, pilates, spinning, BJJ — that no public facility is tagged with. So a
 * class's sport is a canonical sport OR one of these activities, and the two
 * lists never overlap.
 *
 * WHERE THE DIFFERENCE MATTERS: a club check-in can write a member's training
 * log (0043), and training_logs.sport feeds the sport participation boards,
 * which are keyed by CANONICAL sport. `trainingSportFor` folds an activity into
 * the canonical sport it belongs to (yoga → fitness, spinning → cycling), so a
 * yoga class counts toward the same "fitness" board as a session at an outdoor
 * fitness park, and no board fragments into gym-only categories.
 *
 * Slugs follow training_logs_sport_shape (`^[a-z_]{2,40}$`, no digits) as well
 * as club_classes_sport_format, so either table accepts every one of them.
 * Labels live in messages/*.json under `ClubActivities` (an i18n test holds the
 * keys equal to this list).
 */

export const CLUB_ACTIVITIES = [
  'yoga',
  'pilates',
  'crossfit',
  'functional',
  'strength',
  'spinning',
  'aerobics',
  'zumba',
  'dance',
  'stretching',
  'barre',
  'trx',
  'boxing',
  'kickboxing',
  'mma',
  'bjj',
  'judo',
  'karate',
  'taekwondo',
  'aikido',
  'wrestling',
  'aqua_aerobics',
  'padel',
] as const;

export type ClubActivity = (typeof CLUB_ACTIVITIES)[number];
export type ClubSport = CanonicalSport | ClubActivity;

/** Every sport a club may offer or schedule: canonical first, then activities. */
export const CLUB_SPORTS: readonly ClubSport[] = [...CANONICAL_SPORTS, ...CLUB_ACTIVITIES];

const ACTIVITY_TO_SPORT: Readonly<Record<ClubActivity, CanonicalSport>> = {
  yoga: 'fitness',
  pilates: 'fitness',
  crossfit: 'fitness',
  functional: 'fitness',
  strength: 'fitness',
  spinning: 'cycling',
  aerobics: 'fitness',
  zumba: 'fitness',
  dance: 'fitness',
  stretching: 'fitness',
  barre: 'fitness',
  trx: 'fitness',
  boxing: 'martial_arts',
  kickboxing: 'martial_arts',
  mma: 'martial_arts',
  bjj: 'martial_arts',
  judo: 'martial_arts',
  karate: 'martial_arts',
  taekwondo: 'martial_arts',
  aikido: 'martial_arts',
  wrestling: 'martial_arts',
  aqua_aerobics: 'swimming',
  padel: 'tennis',
};

export function isClubActivity(value: unknown): value is ClubActivity {
  return typeof value === 'string' && (CLUB_ACTIVITIES as readonly string[]).includes(value);
}

export function isClubSport(value: unknown): value is ClubSport {
  return (
    typeof value === 'string' &&
    ((CANONICAL_SPORTS as readonly string[]).includes(value) || isClubActivity(value))
  );
}

/** The canonical sport a class's sport counts as on a training log. */
export function trainingSportFor(sport: ClubSport): CanonicalSport {
  return isClubActivity(sport) ? ACTIVITY_TO_SPORT[sport] : sport;
}
