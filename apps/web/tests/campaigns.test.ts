import { renderSql, type SQL } from '@sportkarta/db';
import { CampaignRuleError } from '@sportkarta/lib/campaigns';
import { describe, expect, it } from 'vitest';

import {
  buildCampaignInput,
  cancelCampaign,
  createCampaign,
  localizedText,
  publishCampaign,
  updateCampaign,
} from '@/lib/campaigns';

/**
 * Campaign authoring at the application layer (docs/ROADMAP.md §7, Stage 5.3).
 *
 * The DB-level companion is db/src/campaigns-scoring.test.ts, which attacks the
 * scoring and the minor rules against real Postgres. What is asserted HERE is
 * what a form can and cannot get into the database: an admin submits strings,
 * and a rules document that survives this function is one the SQL compiler is
 * entitled to trust.
 */

function fakeDb(rows: Record<string, unknown>[] = [{ id: 'c1' }]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    execute: async (query: SQL) => {
      const rendered = renderSql(query);
      statements.push(rendered);
      return { rows };
    },
  };
}

/** A complete, valid submission; individual fields are overridden per test. */
function form(overrides: Record<string, string | string[]> = {}): FormData {
  const base: Record<string, string | string[]> = {
    slug: 'avgust-2026',
    scopeKind: 'national',
    startsOn: '2026-08-01',
    endsOn: '2026-08-31',
    leaderboardType: 'individual',
    template: 'standard',
    titleBg: 'Августовска кампания',
    event_facility_added: 'on',
    weight_facility_added: '10',
    ...overrides,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(base)) {
    if (value === '') continue;
    for (const entry of Array.isArray(value) ? value : [value]) data.append(key, entry);
  }
  return data;
}

describe('buildCampaignInput', () => {
  it('accepts a minimal valid submission', () => {
    const input = buildCampaignInput(form());
    expect(input.slug).toBe('avgust-2026');
    expect(input.scope).toEqual({ kind: 'national' });
    expect(input.rules).toEqual({ events: [{ kind: 'facility_added', weight: 10 }] });
    expect(input.titleEn).toBeNull();
  });

  /**
   * The sponsor field (MONETISATION S2, M2). The property worth asserting is
   * that UNSPONSORED IS THE DEFAULT: a form with no sponsor select — every
   * campaign form that existed before M2 — must still produce a valid input
   * rather than a partner id of 0 or NaN.
   */
  it('leaves a campaign unsponsored when no partner is submitted', () => {
    expect(buildCampaignInput(form()).partnerId).toBeNull();
    expect(buildCampaignInput(form({ partnerId: '' })).partnerId).toBeNull();
    expect(buildCampaignInput(form({ partnerId: '   ' })).partnerId).toBeNull();
  });

  it('takes a sponsoring partner id and refuses a malformed one', () => {
    expect(buildCampaignInput(form({ partnerId: '4' })).partnerId).toBe(4);
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() => buildCampaignInput(form({ partnerId: bad }))).toThrow(/partner_unknown/);
    }
  });

  it('collects only the ticked event kinds', () => {
    const input = buildCampaignInput(
      form({
        event_session_checkin: 'on',
        weight_session_checkin: '3',
        // Present but unticked: a weight alone must not score.
        weight_facility_verified: '99',
      }),
    );
    expect(input.rules.events).toEqual([
      { kind: 'facility_added', weight: 10 },
      { kind: 'session_checkin', weight: 3 },
    ]);
  });

  it('cannot be tricked into an event kind the engine does not know', () => {
    // The builder iterates the known kinds rather than the submitted keys, so a
    // crafted field is simply never read.
    const input = buildCampaignInput(
      form({ event_facility_deleted: 'on', weight_facility_deleted: '500' }),
    );
    expect(input.rules.events.map((event) => event.kind)).toEqual(['facility_added']);
  });

  it('rejects a submission with nothing ticked', () => {
    const data = form();
    data.delete('event_facility_added');
    expect(() => buildCampaignInput(data)).toThrow(/rules_no_events/);
  });

  it('rejects a weight that is not a positive integer', () => {
    expect(() => buildCampaignInput(form({ weight_facility_added: '0' }))).toThrow(
      /rules_bad_weight/,
    );
    expect(() => buildCampaignInput(form({ weight_facility_added: 'abc' }))).toThrow(
      /rules_bad_weight/,
    );
  });

  it('carries an optional per-day cap and rejects one below the heaviest weight', () => {
    expect(buildCampaignInput(form({ perDayCap: '30' })).rules.perDayCap).toBe(30);
    expect(() => buildCampaignInput(form({ perDayCap: '3' }))).toThrow(/rules_cap_below_weight/);
  });

  it('carries an optional sports filter, normalised', () => {
    const input = buildCampaignInput(form({ sports: ['tennis', 'basketball'] }));
    expect(input.rules.sports).toEqual(['basketball', 'tennis']);
  });

  it('requires a municipality for a city scope', () => {
    expect(() => buildCampaignInput(form({ scopeKind: 'city' }))).toThrow(
      /scope_needs_municipality/,
    );
    expect(buildCampaignInput(form({ scopeKind: 'city', municipalityId: '7' })).scope).toEqual({
      kind: 'city',
      municipalityId: 7,
    });
  });

  it('requires a quarter for a quarter scope', () => {
    expect(() => buildCampaignInput(form({ scopeKind: 'quarter', municipalityId: '7' }))).toThrow(
      /scope_needs_quarter/,
    );
  });

  it('rejects a window whose end precedes its start', () => {
    expect(() => buildCampaignInput(form({ endsOn: '2026-07-01' }))).toThrow(
      /window_ends_before_start/,
    );
  });

  it('rejects an unknown leaderboard type or template', () => {
    expect(() => buildCampaignInput(form({ leaderboardType: 'team' }))).toThrow(
      /leaderboard_type_unknown/,
    );
    expect(() => buildCampaignInput(form({ template: 'fancy' }))).toThrow(/template_unknown/);
  });

  it('requires a Bulgarian title — the product is Bulgarian-first', () => {
    const data = form();
    data.set('titleBg', '   ');
    expect(() => buildCampaignInput(data)).toThrow(/title_required/);
  });

  it('throws CampaignRuleError so the action can map it to an i18n key', () => {
    try {
      buildCampaignInput(form({ slug: 'НЕ ЛАТИНИЦА' }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CampaignRuleError);
      expect((error as CampaignRuleError).code).toBe('slug_invalid');
    }
  });
});

describe('persistence', () => {
  it('stores the rules as a JSONB document, not as columns', async () => {
    const db = fakeDb();
    await createCampaign(db, buildCampaignInput(form({ perDayCap: '30' })));
    const statement = db.statements[0];
    expect(statement?.sql).toContain('::jsonb');
    expect(statement?.params).toContain(
      JSON.stringify({ events: [{ kind: 'facility_added', weight: 10 }], perDayCap: 30 }),
    );
  });

  it('refuses to edit a closed campaign', async () => {
    // The guard is in the WHERE clause, so a closed campaign updates zero rows
    // even if a caller forgets to check first: its frozen results were computed
    // under the old rules and must remain derivable from them.
    const db = fakeDb([]);
    const changed = await updateCampaign(db, 'c1', buildCampaignInput(form()));
    expect(changed).toBe(false);
    expect(db.statements[0]?.sql).toContain("status <> 'closed'");
  });

  it('never resurrects a closed campaign by publishing it', async () => {
    const db = fakeDb([]);
    await publishCampaign(db, 'c1');
    expect(db.statements[0]?.sql).toContain("status IN ('draft', 'cancelled')");
  });

  it('cancels without deleting, so a shared link keeps resolving', async () => {
    const db = fakeDb();
    await cancelCampaign(db, 'c1');
    expect(db.statements[0]?.sql).toContain('UPDATE campaigns');
    expect(db.statements[0]?.sql).not.toMatch(/DELETE/i);
    expect(db.statements[0]?.sql).toContain("status <> 'closed'");
  });
});

describe('localizedText', () => {
  it('falls back to Bulgarian when a translation is missing', () => {
    expect(localizedText('Заглавие', null, 'en')).toBe('Заглавие');
    expect(localizedText('Заглавие', 'Title', 'en')).toBe('Title');
    // bg never falls back to en: the product is Bulgarian-first, and an English
    // string on the Bulgarian page would be a worse failure than a missing one.
    expect(localizedText('Заглавие', 'Title', 'bg')).toBe('Заглавие');
  });
});
