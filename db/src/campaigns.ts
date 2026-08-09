import {
  campaignWindowInstants,
  CITY_BOARD_MIN_MEMBERS,
  type CampaignLeaderboardType,
  type CampaignRules,
  type CampaignScope,
  type CampaignStatus,
  type CampaignTemplate,
  type CampaignWindow,
} from '@sportkarta/lib/campaigns';
import { SOFIA_TZ } from '@sportkarta/lib/recurrence';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Compiling a campaign's rules document into SQL (docs/ROADMAP.md §7, Stage 5.3).
 *
 * The document arriving here is ALREADY VALIDATED by
 * lib/src/campaigns/rules.ts — that is the contract, and it is what lets this
 * file stay small enough to audit. Nothing here re-derives the grammar; it
 * translates a known-good document into one aggregate.
 *
 * TWO AUDIENCES, TWO QUERIES, ONE SCORING RULE. Scoring counts EVERYONE.
 * Display is what differs:
 *
 *   publicStandings   individual boards join leaderboard_eligible_members
 *                     (0011, amended by 0020), so a member who has not
 *                     published their passport is never named. Age is not a
 *                     condition — the minor exclusion was removed by 0020.
 *   adminStandings    every member, by real name, to organisers only — because
 *                     somebody has to hand over the prize, and a campaign that
 *                     silently cannot award a private member is a campaign that
 *                     quietly excluded them from competing.
 *
 * A city (aggregate) board counts everyone in both: no individual is named —
 * but a municipality with fewer than CITY_BOARD_MIN_MEMBERS contributors is
 * SUPPRESSED, because a city row backed by one person publishes that person's
 * score under a city label, which is the same disclosure with extra steps.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface CampaignRow {
  id: string;
  slug: string;
  status: CampaignStatus;
  scope: CampaignScope;
  window: CampaignWindow;
  leaderboardType: CampaignLeaderboardType;
  template: CampaignTemplate;
  rules: CampaignRules;
  titleBg: string;
  titleEn: string | null;
  blurbBg: string | null;
  blurbEn: string | null;
  prizeBg: string | null;
  prizeEn: string | null;
  /**
   * The sponsor's partner id, or null (MONETISATION S2). Just the id: the name,
   * logo and link are read from `partners` through the renderability rule at
   * display time, so a hidden or lapsed sponsor disappears from the campaign
   * without this row changing.
   */
  partnerId: number | null;
  closedAt: string | null;
}

function toScope(row: Record<string, unknown>): CampaignScope {
  const kind = String(row.scope_kind);
  if (kind === 'city') return { kind: 'city', municipalityId: Number(row.municipality_id) };
  if (kind === 'quarter') {
    return {
      kind: 'quarter',
      municipalityId: Number(row.municipality_id),
      quarter: String(row.quarter),
    };
  }
  return { kind: 'national' };
}

/** `YYYY-MM-DD` from whatever the driver hands back for a `date` column. */
function toCivilDate(value: unknown): string {
  if (value instanceof Date) {
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    // A `date` arrives as local midnight; read the LOCAL parts, not the UTC
    // ones, or a UTC-behind process shifts every campaign window by a day.
    return `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function toCampaign(row: Record<string, unknown>): CampaignRow {
  return {
    id: String(row.id),
    slug: String(row.slug),
    status: String(row.status) as CampaignStatus,
    scope: toScope(row),
    window: { startsOn: toCivilDate(row.starts_on), endsOn: toCivilDate(row.ends_on) },
    leaderboardType: String(row.leaderboard_type) as CampaignLeaderboardType,
    template: String(row.template) as CampaignTemplate,
    rules: row.rules as CampaignRules,
    titleBg: String(row.title_bg),
    titleEn: row.title_en === null ? null : String(row.title_en),
    blurbBg: row.blurb_bg === null ? null : String(row.blurb_bg),
    blurbEn: row.blurb_en === null ? null : String(row.blurb_en),
    prizeBg: row.prize_bg === null ? null : String(row.prize_bg),
    prizeEn: row.prize_en === null ? null : String(row.prize_en),
    partnerId:
      row.partner_id === null || row.partner_id === undefined ? null : Number(row.partner_id),
    closedAt: row.closed_at === null ? null : String(row.closed_at),
  };
}

const CAMPAIGN_COLUMNS = sql`
  id, slug, status, scope_kind, municipality_id, quarter, starts_on, ends_on,
  leaderboard_type, template, rules, title_bg, title_en, blurb_bg, blurb_en,
  prize_bg, prize_en, partner_id, closed_at
`;

export async function campaignBySlug(db: SqlRunner, slug: string): Promise<CampaignRow | null> {
  const result = await db.execute(sql`
    SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE slug = ${slug}
  `);
  const row = result.rows[0];
  return row ? toCampaign(row) : null;
}

export async function campaignById(db: SqlRunner, id: string): Promise<CampaignRow | null> {
  const result = await db.execute(sql`
    SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE id = ${id}::uuid
  `);
  const row = result.rows[0];
  return row ? toCampaign(row) : null;
}

export interface ListCampaignsOptions {
  /** Omit to list everything (the admin view). */
  statuses?: CampaignStatus[];
}

export async function listCampaigns(
  db: SqlRunner,
  options: ListCampaignsOptions = {},
): Promise<CampaignRow[]> {
  const statusFilter = options.statuses?.length
    ? sql` WHERE status = ANY(${sql.param(options.statuses)}::campaign_status[])`
    : sql``;
  const result = await db.execute(sql`
    SELECT ${CAMPAIGN_COLUMNS} FROM campaigns${statusFilter}
    ORDER BY starts_on DESC, created_at DESC
  `);
  return result.rows.map(toCampaign);
}

/**
 * The weighted score expression: `sum(CASE kind WHEN … THEN weight END)`.
 *
 * Weights multiply the COUNT of qualifying events, not the ledger's own points.
 * That decoupling is the point of a campaign — "this month a condition report
 * is worth five times an add" — and it means a campaign can never disturb the
 * global points economy the passport reports.
 */
function weightExpression(rules: CampaignRules): SQL {
  const branches = rules.events.map((event) => sql`WHEN ${event.kind} THEN ${event.weight}::int`);
  return sql`CASE e.kind ${sql.join(branches, sql` `)} ELSE 0 END`;
}

function scopeFilter(scope: CampaignScope): SQL {
  switch (scope.kind) {
    case 'national':
      return sql``;
    case 'city':
      return sql` AND f.municipality_id = ${scope.municipalityId}`;
    case 'quarter':
      return sql` AND f.municipality_id = ${scope.municipalityId} AND f.quarter = ${scope.quarter}`;
  }
}

function sportsFilter(rules: CampaignRules): SQL {
  return rules.sports?.length
    ? sql` AND f.sport_types && ${sql.param(rules.sports)}::text[]`
    : sql``;
}

/**
 * Every qualifying event in the window, as (user, municipality, day, weight).
 *
 * Both sources are unioned here so the per-day cap and the scope filter apply
 * identically to contributions and attendance — a cap that only bound one of
 * them would be trivially avoidable.
 */
function eventStream(campaign: CampaignRow, timeZone: string): SQL {
  const { from, to } = campaignWindowInstants(campaign.window, timeZone);
  const kinds = campaign.rules.events.map((event) => event.kind);
  const wantsCheckins = kinds.includes('session_checkin');
  const ledgerKinds = kinds.filter((kind) => kind !== 'session_checkin');

  const ledger = ledgerKinds.length
    ? sql`
      SELECT p.user_id AS user_id,
             p.event::text AS kind,
             f.municipality_id AS municipality_id,
             (p.created_at AT TIME ZONE ${timeZone})::date AS day
      FROM points_ledger p
      JOIN facilities f ON f.id = p.facility_id
      WHERE p.created_at >= ${from.toISOString()}::timestamptz
        AND p.created_at <  ${to.toISOString()}::timestamptz
        AND p.event::text = ANY(${sql.param(ledgerKinds)}::text[])
        ${scopeFilter(campaign.scope)}
        ${sportsFilter(campaign.rules)}
    `
    : null;

  const checkins = wantsCheckins
    ? sql`
      SELECT c.user_id AS user_id,
             'session_checkin' AS kind,
             f.municipality_id AS municipality_id,
             (c.checked_in_at AT TIME ZONE ${timeZone})::date AS day
      FROM play_session_checkins c
      JOIN play_session_occurrences o ON o.id = c.occurrence_id
      JOIN play_sessions s            ON s.id = o.session_id
      JOIN facilities f               ON f.id = s.facility_id
      WHERE c.checked_in_at >= ${from.toISOString()}::timestamptz
        AND c.checked_in_at <  ${to.toISOString()}::timestamptz
        -- VERIFIED ATTENDANCE ONLY (Stage 5.4). A campaign is the one place
        -- where gaming this wins a real PRIZE, so a self-attested tap — a
        -- button somebody pressed at home — must not count towards one.
        -- Filtered on the METHOD rather than on the scored flag, deliberately:
        -- an attendance that hit the daily points cap, or came from a member
        -- who declined the location prompt, is still a VERIFIED attendance,
        -- and a campaign should count turning up rather than being paid.
        AND c.method = 'qr'
        ${scopeFilter(campaign.scope)}
        ${sportsFilter(campaign.rules)}
    `
    : null;

  const parts = [ledger, checkins].filter((part): part is SQL => part !== null);
  // Validation guarantees at least one event kind, so `parts` is never empty.
  return sql.join(parts, sql` UNION ALL `);
}

/**
 * Per-member totals, with the per-day cap applied.
 *
 * The cap is `sum(LEAST(daily, cap))` over SOFIA CIVIL DAYS — bucketed with
 * `AT TIME ZONE`, so a burst at 23:00 and another at 01:00 fall in different
 * days exactly as a member would expect, and the two DST days are still one day
 * each. Without the cap the same expression collapses to a plain sum.
 */
function memberTotals(campaign: CampaignRow, timeZone: string): SQL {
  const cap = campaign.rules.perDayCap;
  const daily = sql`
    SELECT e.user_id AS user_id,
           e.day AS day,
           max(e.municipality_id) AS municipality_id,
           sum(${weightExpression(campaign.rules)})::int AS day_score,
           count(*)::int AS day_events
    FROM (${eventStream(campaign, timeZone)}) e
    GROUP BY e.user_id, e.day
  `;
  const scored = cap === undefined ? sql`d.day_score` : sql`LEAST(d.day_score, ${cap}::int)`;
  return sql`
    SELECT d.user_id AS user_id,
           sum(${scored})::int AS score,
           sum(d.day_events)::int AS events,
           -- The member's own municipality for a city board: the one they were
           -- most active in during this campaign, not their profile's home city,
           -- which is free text and may be anywhere.
           (array_agg(d.municipality_id ORDER BY d.day_score DESC NULLS LAST))[1] AS municipality_id
    FROM (${daily}) d
    GROUP BY d.user_id
  `;
}

export interface StandingRow {
  rank: number;
  score: number;
  events: number;
  /** Individual boards: the passport handle, or null when not displayable. */
  handle: string | null;
  displayName: string | null;
  userId: string | null;
  /** City boards. */
  municipalityId: number | null;
  memberCount: number;
}

function mapStanding(row: Record<string, unknown>): StandingRow {
  return {
    rank: Number(row.rank),
    score: Number(row.score),
    events: Number(row.events ?? 0),
    handle: row.handle === null || row.handle === undefined ? null : String(row.handle),
    displayName:
      row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id),
    municipalityId:
      row.municipality_id === null || row.municipality_id === undefined
        ? null
        : Number(row.municipality_id),
    memberCount: Number(row.member_count ?? 1),
  };
}

export interface StandingsOptions {
  limit?: number;
  timeZone?: string;
}

/**
 * The PUBLIC board.
 *
 * Individual: joins leaderboard_eligible_members, so an unpublished member is
 * scored but never named. Ranks are computed AFTER that join, so the public
 * board reads 1, 2, 3 without gaps that would otherwise advertise the existence
 * of hidden competitors.
 *
 * City: aggregates every member — nobody is named — with municipalities below
 * the k-anonymity floor suppressed.
 */
export async function publicStandings(
  db: SqlRunner,
  campaign: CampaignRow,
  options: StandingsOptions = {},
): Promise<StandingRow[]> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const totals = memberTotals(campaign, timeZone);

  if (campaign.leaderboardType === 'city') {
    const result = await db.execute(sql`
      SELECT municipality_id, score, events, member_count,
             rank() OVER (ORDER BY score DESC)::int AS rank
      FROM (
        SELECT t.municipality_id AS municipality_id,
               sum(t.score)::int AS score,
               sum(t.events)::int AS events,
               count(*)::int AS member_count
        FROM (${totals}) t
        WHERE t.municipality_id IS NOT NULL
        GROUP BY t.municipality_id
        -- k-anonymity: a city row backed by fewer than this many members is
        -- one person's score wearing a city's name.
        HAVING count(*) >= ${CITY_BOARD_MIN_MEMBERS}
      ) agg
      ORDER BY score DESC, municipality_id
      LIMIT ${limit}
    `);
    return result.rows.map(mapStanding);
  }

  const result = await db.execute(sql`
    SELECT handle, display_name, score, events,
           rank() OVER (ORDER BY score DESC)::int AS rank
    FROM (
      SELECT m.public_handle AS handle, m.display_name AS display_name,
             t.score AS score, t.events AS events
      FROM (${totals}) t
      JOIN leaderboard_eligible_members m ON m.id = t.user_id
    ) eligible
    ORDER BY score DESC, display_name
    LIMIT ${limit}
  `);
  return result.rows.map(mapStanding);
}

/**
 * The ADMIN board: everyone, by name, including members who never published a
 * passport.
 *
 * This exists so a prize can actually be awarded. Scoring already counted these
 * people — excluding them from the organisers' view too would mean a campaign
 * that let members compete and then quietly could not tell anyone they had won.
 * The page behind this is `requireRole('admin')`.
 *
 * IT DOES NOT SELECT `is_minor`, and that is deliberate rather than leftover.
 * It used to: the flag explained why a top scorer was absent from the public
 * board, back when being a minor was the reason. Since 0020 the only reason is
 * `is_public`, so the flag would explain nothing — and it would put "this
 * competitor is a child" on an operator's screen next to their real name, which
 * is the disclosure `apps/web/lib/sessions/roster.ts` refuses for the same
 * reason. Age is not an organiser's business.
 */
export async function adminStandings(
  db: SqlRunner,
  campaign: CampaignRow,
  options: StandingsOptions = {},
): Promise<(StandingRow & { isPublic: boolean })[]> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const totals = memberTotals(campaign, timeZone);

  const result = await db.execute(sql`
    SELECT u.id AS user_id, u.display_name AS display_name,
           (u.profile_visibility = 'public') AS is_public,
           t.score AS score, t.events AS events, t.municipality_id AS municipality_id,
           rank() OVER (ORDER BY t.score DESC)::int AS rank
    FROM (${totals}) t
    JOIN users u ON u.id = t.user_id
    ORDER BY t.score DESC, u.display_name
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    ...mapStanding(row),
    isPublic: row.is_public === true,
  }));
}

/** One member's own score in a campaign, whatever their visibility. */
export async function campaignStanding(
  db: SqlRunner,
  campaign: CampaignRow,
  userId: string,
  options: StandingsOptions = {},
): Promise<{ rank: number; score: number; events: number } | null> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const totals = memberTotals(campaign, timeZone);
  const result = await db.execute(sql`
    WITH board AS (
      SELECT t.user_id AS user_id, t.score AS score, t.events AS events,
             rank() OVER (ORDER BY t.score DESC)::int AS rank
      FROM (${totals}) t
    )
    SELECT rank, score, events FROM board WHERE user_id = ${userId}
  `);
  const row = result.rows[0];
  return row
    ? { rank: Number(row.rank), score: Number(row.score), events: Number(row.events) }
    : null;
}

export interface CloseReport {
  frozenRows: number;
  alreadyClosed: boolean;
}

/**
 * Close a campaign: FREEZE the standings, then mark it closed — in one
 * transaction, and only if it is not closed already.
 *
 * The status flip goes FIRST, and it is the claim: `status <> 'closed'` inside
 * the UPDATE means two admins clicking at once produce one snapshot, because
 * the second transaction updates zero rows and reports alreadyClosed instead of
 * writing a second set of standings on top of the first. Claim-then-write is
 * the same shape as digest_sends (4.4).
 *
 * Both statements are in ONE transaction, so there is no window where a closed
 * campaign has no snapshot: a crash between them rolls the flip back too. The
 * DELETE before the insert covers the other direction — rows left by a close
 * that was rolled back after partially inserting.
 *
 * WHICH BOARD IS FROZEN: the one the campaign declares. An individual campaign
 * freezes members INCLUDING those not publicly displayable — the placing is the
 * fact, and the results page resolves who may be named at render time. Freezing
 * only the displayable ones would silently renumber the winners.
 */
export async function closeCampaign(
  db: SqlRunner & { transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> },
  campaign: CampaignRow,
  options: StandingsOptions & { now?: Date } = {},
): Promise<CloseReport> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const totals = memberTotals(campaign, timeZone);

  return db.transaction(async (tx) => {
    const claim = await tx.execute(sql`
      UPDATE campaigns
      SET status = 'closed', closed_at = now(), updated_at = now()
      WHERE id = ${campaign.id}::uuid AND status <> 'closed'
      RETURNING id
    `);
    if (claim.rows.length === 0) return { frozenRows: 0, alreadyClosed: true };

    // Belt and braces for a retried close after a partial write.
    await tx.execute(sql`DELETE FROM campaign_results WHERE campaign_id = ${campaign.id}::uuid`);

    if (campaign.leaderboardType === 'city') {
      const inserted = await tx.execute(sql`
        INSERT INTO campaign_results (campaign_id, municipality_id, rank, score, member_count)
        SELECT ${campaign.id}::uuid, municipality_id, rank, score, member_count
        FROM (
          SELECT agg.municipality_id, agg.score, agg.member_count,
                 rank() OVER (ORDER BY agg.score DESC)::int AS rank
          FROM (
            SELECT t.municipality_id AS municipality_id, sum(t.score)::int AS score,
                   count(*)::int AS member_count
            FROM (${totals}) t
            WHERE t.municipality_id IS NOT NULL
            GROUP BY t.municipality_id
            HAVING count(*) >= ${CITY_BOARD_MIN_MEMBERS}
          ) agg
        ) ranked
        RETURNING id
      `);
      return { frozenRows: inserted.rows.length, alreadyClosed: false };
    }

    const inserted = await tx.execute(sql`
      INSERT INTO campaign_results (campaign_id, user_id, rank, score, member_count)
      SELECT ${campaign.id}::uuid, user_id, rank, score, 1
      FROM (
        SELECT t.user_id AS user_id, t.score AS score,
               rank() OVER (ORDER BY t.score DESC)::int AS rank
        FROM (${totals}) t
      ) ranked
      RETURNING id
    `);
    return { frozenRows: inserted.rows.length, alreadyClosed: false };
  });
}

export interface FrozenResultRow {
  rank: number;
  score: number;
  memberCount: number;
  /** Null when the member is erased or no longer public. */
  handle: string | null;
  displayName: string | null;
  municipalityId: number | null;
  /** True when there was a member here whose name may not be shown. */
  withheld: boolean;
}

/**
 * The frozen close-out standings, with identity resolved LIVE.
 *
 * The numbers come from campaign_results and never move again. The names come
 * from leaderboard_eligible_members at render time, so:
 *
 *   - an erased member keeps their placing and has no name to show;
 *   - a member who has since made their passport private keeps their placing
 *     and withdraws their name.
 *
 * `withheld` lets the page render "участник" rather than a blank, so the
 * ranking stays legible instead of looking broken.
 */
export async function frozenResults(
  db: SqlRunner,
  campaignId: string,
  limit = 100,
): Promise<FrozenResultRow[]> {
  const result = await db.execute(sql`
    SELECT r.rank, r.score, r.member_count, r.municipality_id,
           m.public_handle AS handle, m.display_name AS display_name,
           (r.user_id IS NOT NULL) AS had_member
    FROM campaign_results r
    LEFT JOIN leaderboard_eligible_members m ON m.id = r.user_id
    WHERE r.campaign_id = ${campaignId}::uuid
    ORDER BY r.rank, r.id
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    rank: Number(row.rank),
    score: Number(row.score),
    memberCount: Number(row.member_count ?? 1),
    handle: row.handle === null || row.handle === undefined ? null : String(row.handle),
    displayName:
      row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    municipalityId: row.municipality_id === null ? null : Number(row.municipality_id),
    withheld: row.municipality_id === null && row.handle === null,
  }));
}
