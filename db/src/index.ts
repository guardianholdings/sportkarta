export { getDb } from './client.js';
export { checkDbHealth } from './health.js';
export type { DbHealth } from './health.js';
export { refreshStats, STATS_MATVIEWS } from './stats.js';
export { HORIZON_WEEKS, materializeSessions } from './sessions/materialize.js';
export {
  claimDigestSend,
  digestRecipients,
  formatWeekStart,
  weeklyDigest,
  weekStartFor,
  weekWindow,
} from './digest.js';
export type {
  DigestOccurrence,
  DigestRecipient,
  DigestWeek,
  WeeklyDigestOptions,
} from './digest.js';
export type {
  MaterializeFailure,
  MaterializeOptions,
  MaterializeReport,
} from './sessions/materialize.js';
export {
  cancellationRecipients,
  claimNotification,
  dueReminders,
  goingUserIds,
  recipientsFor,
  REMINDER_LEAD_HOURS,
  seriesCancellationRecipients,
} from './sessions/notifications.js';
export type {
  ReminderKind,
  SessionMailRecipient,
  SessionNotificationKind,
} from './sessions/notifications.js';
export {
  calendarFeed,
  calendarOccurrence,
  calendarToken,
  ensureCalendarToken,
  FEED_PAST_DAYS,
  generateCalendarToken,
  rotateCalendarToken,
} from './sessions/calendar.js';
export type { CalendarFeed, CalendarOccurrence } from './sessions/calendar.js';
export {
  adminStandings,
  campaignById,
  campaignBySlug,
  campaignStanding,
  closeCampaign,
  frozenResults,
  listCampaigns,
  publicStandings,
} from './campaigns.js';
export type {
  CampaignRow,
  CloseReport,
  FrozenResultRow,
  StandingRow,
} from './campaigns.js';
export { leaderboard, leaderboardCities, memberStanding, monthStart } from './leaderboard.js';
export type {
  LeaderboardEntry,
  LeaderboardOptions,
  LeaderboardPeriod,
  LeaderboardScope,
  MemberStanding,
} from './leaderboard.js';
export {
  markBadgesSeen,
  passportEvents,
  passportHistory,
  passportTotals,
  publicMonthlyActivity,
  publicPassportOwner,
  recordEarnedBadges,
  unseenBadges,
} from './passport.js';
export type {
  MonthlyActivity,
  PassportHistoryEntry,
  PassportTotals,
  PublicPassportOwner,
} from './passport.js';

// Single drizzle instance for the whole workspace. Callers MUST build queries
// with this `sql` rather than importing drizzle-orm directly: pnpm keys package
// instances by their resolved peer deps, so a dependency that drags in one of
// drizzle's optional peers (better-auth pulls kysely) silently creates a second
// drizzle-orm copy whose SQL type is incompatible with this package's `db`.
export { sql } from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';
export { renderSql } from './render-sql.js';
