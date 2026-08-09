import { sql, type SQL } from '@sportkarta/db';
import {
  validateCampaignRules,
  validateCampaignScope,
  validateCampaignSlug,
  validateCampaignWindow,
  CampaignRuleError,
  isCampaignLeaderboardType,
  isCampaignTemplate,
  type CampaignRules,
  type CampaignScope,
} from '@sportkarta/lib/campaigns';
import { PASSPORT_EVENT_KINDS, type PassportEventKind } from '@sportkarta/lib/badges';

/**
 * Campaign authoring (docs/ROADMAP.md §7, Stage 5.3).
 *
 * Everything an admin can submit passes through buildCampaignInput, which is
 * pure and throws before any database work. The rules document in particular is
 * validated here rather than trusted: it arrives as form fields, is stored as
 * JSONB — which the database cannot type-check beyond a coarse shape — and is
 * later compiled into the SQL that decides who wins a prize.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface CampaignInput {
  slug: string;
  scope: CampaignScope;
  startsOn: string;
  endsOn: string;
  leaderboardType: 'individual' | 'city';
  template: 'standard' | 'sprint' | 'city_race';
  rules: CampaignRules;
  titleBg: string;
  titleEn: string | null;
  blurbBg: string | null;
  blurbEn: string | null;
  prizeBg: string | null;
  prizeEn: string | null;
  /**
   * The sponsoring partner, or null (MONETISATION S2). Only an id crosses this
   * boundary: the sponsor's name, logo and link are read from `partners` at
   * render time through the renderability rule, so a hidden or lapsed partner
   * withdraws the sponsor line without anybody editing the campaign.
   */
  partnerId: number | null;
}

const TITLE_MAX = 120;
const TEXT_MAX = 2000;

function text(value: FormDataEntryValue | null, max: number): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new CampaignRuleError('text_too_long');
  return trimmed;
}

/**
 * Build the weighted event list from the form.
 *
 * The form renders one checkbox and one number per event kind, so an unticked
 * kind simply has no weight. Iterating PASSPORT_EVENT_KINDS rather than the
 * submitted keys means a crafted request cannot introduce an event kind the
 * engine does not know — it can only set weights on kinds that exist.
 */
function eventsFromForm(formData: FormData): { kind: PassportEventKind; weight: number }[] {
  const events: { kind: PassportEventKind; weight: number }[] = [];
  for (const kind of PASSPORT_EVENT_KINDS) {
    if (formData.get(`event_${kind}`) !== 'on') continue;
    const raw = String(formData.get(`weight_${kind}`) ?? '').trim();
    events.push({ kind, weight: Number(raw) });
  }
  return events;
}

export function buildCampaignInput(formData: FormData): CampaignInput {
  const slug = validateCampaignSlug(formData.get('slug'));
  const scope = validateCampaignScope(
    formData.get('scopeKind'),
    formData.get('municipalityId'),
    formData.get('quarter'),
  );
  const window = validateCampaignWindow(formData.get('startsOn'), formData.get('endsOn'));

  const leaderboardType = formData.get('leaderboardType');
  if (!isCampaignLeaderboardType(leaderboardType)) {
    throw new CampaignRuleError('leaderboard_type_unknown');
  }
  const template = formData.get('template');
  if (!isCampaignTemplate(template)) throw new CampaignRuleError('template_unknown');

  const capRaw = String(formData.get('perDayCap') ?? '').trim();
  const sports = formData.getAll('sports').map(String).filter(Boolean);

  const rules = validateCampaignRules({
    events: eventsFromForm(formData),
    ...(sports.length ? { sports } : {}),
    ...(capRaw ? { perDayCap: Number(capRaw) } : {}),
  });

  const titleBg = text(formData.get('titleBg'), TITLE_MAX);
  if (!titleBg) throw new CampaignRuleError('title_required');

  return {
    slug,
    scope,
    startsOn: window.startsOn,
    endsOn: window.endsOn,
    leaderboardType,
    template,
    rules,
    titleBg,
    titleEn: text(formData.get('titleEn'), TITLE_MAX),
    blurbBg: text(formData.get('blurbBg'), TEXT_MAX),
    blurbEn: text(formData.get('blurbEn'), TEXT_MAX),
    prizeBg: text(formData.get('prizeBg'), TEXT_MAX),
    prizeEn: text(formData.get('prizeEn'), TEXT_MAX),
    partnerId: partnerIdFromForm(formData),
  };
}

/**
 * The sponsor field: empty means unsponsored, which is the normal case.
 *
 * A posted id is only shape-checked here; whether that partner may sponsor a
 * campaign at all (tier headline/category — §S1's table is what those tiers
 * sell) is enforced where the tiers are known, in the admin page that builds
 * the select. The FK catches an id that does not exist.
 */
function partnerIdFromForm(formData: FormData): number | null {
  const raw = String(formData.get('partnerId') ?? '').trim();
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new CampaignRuleError('partner_unknown');
  return id;
}

function scopeColumns(scope: CampaignScope): {
  municipalityId: number | null;
  quarter: string | null;
} {
  if (scope.kind === 'national') return { municipalityId: null, quarter: null };
  if (scope.kind === 'city') return { municipalityId: scope.municipalityId, quarter: null };
  return { municipalityId: scope.municipalityId, quarter: scope.quarter };
}

export async function createCampaign(db: SqlRunner, input: CampaignInput): Promise<string> {
  const { municipalityId, quarter } = scopeColumns(input.scope);
  const result = await db.execute(sql`
    INSERT INTO campaigns (
      slug, scope_kind, municipality_id, quarter, starts_on, ends_on,
      leaderboard_type, template, rules, title_bg, title_en,
      blurb_bg, blurb_en, prize_bg, prize_en, partner_id
    ) VALUES (
      ${input.slug}, ${input.scope.kind}::campaign_scope_kind, ${municipalityId}, ${quarter},
      ${input.startsOn}::date, ${input.endsOn}::date,
      ${input.leaderboardType}::campaign_leaderboard_type,
      ${input.template}::campaign_template,
      ${JSON.stringify(input.rules)}::jsonb,
      ${input.titleBg}, ${input.titleEn}, ${input.blurbBg}, ${input.blurbEn},
      ${input.prizeBg}, ${input.prizeEn}, ${input.partnerId}
    )
    RETURNING id
  `);
  return String(result.rows[0]?.id);
}

/**
 * Edit a campaign.
 *
 * The `status <> 'closed'` guard is the important part: a closed campaign's
 * rules and window are the definition its frozen results were computed under.
 * Editing them afterwards would leave a published results page whose numbers
 * cannot be derived from the campaign it claims to describe.
 */
export async function updateCampaign(
  db: SqlRunner,
  id: string,
  input: CampaignInput,
): Promise<boolean> {
  const { municipalityId, quarter } = scopeColumns(input.scope);
  const result = await db.execute(sql`
    UPDATE campaigns SET
      slug = ${input.slug},
      scope_kind = ${input.scope.kind}::campaign_scope_kind,
      municipality_id = ${municipalityId},
      quarter = ${quarter},
      starts_on = ${input.startsOn}::date,
      ends_on = ${input.endsOn}::date,
      leaderboard_type = ${input.leaderboardType}::campaign_leaderboard_type,
      template = ${input.template}::campaign_template,
      rules = ${JSON.stringify(input.rules)}::jsonb,
      title_bg = ${input.titleBg}, title_en = ${input.titleEn},
      blurb_bg = ${input.blurbBg}, blurb_en = ${input.blurbEn},
      prize_bg = ${input.prizeBg}, prize_en = ${input.prizeEn},
      partner_id = ${input.partnerId},
      updated_at = now()
    WHERE id = ${id}::uuid AND status <> 'closed'
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** draft → published. Idempotent, and never resurrects a closed campaign. */
export async function publishCampaign(db: SqlRunner, id: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE campaigns SET status = 'published', updated_at = now()
    WHERE id = ${id}::uuid AND status IN ('draft', 'cancelled')
    RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * Withdraw a campaign that has not been closed.
 *
 * Cancelling is not deleting: the slug stays taken and the row stays readable,
 * because a campaign that was announced and then pulled is a thing that
 * happened, and reusing its URL for something else would confuse anybody
 * holding the old link.
 */
export async function cancelCampaign(db: SqlRunner, id: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE campaigns SET status = 'cancelled', updated_at = now()
    WHERE id = ${id}::uuid AND status <> 'closed'
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** Bilingual content with a bg fallback — en is optional by design. */
export function localizedText(bg: string | null, en: string | null, locale: string): string | null {
  if (locale === 'en') return en ?? bg;
  return bg;
}
