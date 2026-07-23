export * from './rrule.js';
export * from './zoned.js';

/**
 * The one zone the platform schedules in today. play_sessions.timezone carries
 * it per row (CHECK-pinned to this value) so the wall-clock model is explicit
 * rather than implied — going multi-timezone is then a CHECK edit, not a data
 * migration.
 */
export const SOFIA_TZ = 'Europe/Sofia';
