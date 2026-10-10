'use server';

import { getDb, sql, type SQL } from '@sportkarta/db';
import { CANONICAL_SPORTS, CANONICAL_SURFACES, mergeFields, type JsonValue } from '@sportkarta/lib';
import { revalidatePath } from 'next/cache';

import { ACCESS_VALUES, CONDITION_VALUES, isUuid } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/auth-session';
import { locationChanged, parseLocation } from '@/lib/facility-editor';
import { scopeClause } from '@/lib/moderation';

function optionalText(value: FormDataEntryValue | null): string | null {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error('invalid enum value');
}

export interface FacilityEditState {
  /** Why nothing was written: not a point in Bulgaria, or a pin moved out of scope. */
  error: 'location' | 'scope' | null;
  /** Changes applied by the save that just went through. */
  saved?: number;
}

/**
 * Operator edit: every applied change is one facility_edits audit row with
 * actor (from the verified session, never from the form) and source='crowd' —
 * top merge-policy priority, so these fields freeze against OSM re-imports.
 *
 * NOT THE STATUS (A-4). Publishing a facility or marking it gone is a
 * moderation decision: it is logged to moderation_decisions with a reason, and
 * the author is sent the statement of reasons. This form used to set `status`
 * with none of that, so it no longer reads the field at all; the editor offers
 * the logged decision itself (moderation/actions.ts decideFacility) instead.
 *
 * Municipality-scoped since Stage 3.3: it still rewrites every other field and
 * can move the pin, so an unscoped version would let any ambassador rewrite a
 * facility on the other side of the country. The scope is in the UPDATE
 * itself, not only in this check.
 *
 * A refusal RETURNS, rather than redirecting: a redirect re-rendered the form
 * from the database and lost every other edit the operator had made (A-2).
 */
export async function saveFacility(
  facilityId: string,
  _prev: FacilityEditState,
  formData: FormData,
): Promise<FacilityEditState> {
  const user = await requireAdmin();
  const actor = user.id;
  const scope = scopeClause({ id: user.id, role: user.role });
  if (!isUuid(facilityId)) throw new Error('invalid facility id');

  const sports = formData
    .getAll('sports')
    .map(String)
    .filter((s): s is (typeof CANONICAL_SPORTS)[number] =>
      (CANONICAL_SPORTS as readonly string[]).includes(s),
    )
    .sort();
  const surfaceRaw = optionalText(formData.get('surface'));
  const lightingRaw = String(formData.get('lighting') ?? 'unknown');
  const conditionRaw = optionalText(formData.get('condition'));
  const location = parseLocation(formData.get('lon'), formData.get('lat'));
  if (location === 'invalid') return { error: 'location' };

  const incoming: Record<string, JsonValue> = {
    name: optionalText(formData.get('name')),
    quarter: optionalText(formData.get('quarter')),
    sport_types: sports,
    surface: surfaceRaw === null ? null : oneOf(surfaceRaw, CANONICAL_SURFACES),
    lighting: lightingRaw === 'yes' ? true : lightingRaw === 'no' ? false : null,
    covered: formData.get('covered') === 'on',
    access: oneOf(formData.get('access'), ACCESS_VALUES),
    // The operator's answer to a disputed or remote condition report
    // (finding 53/62): set it, or clear it back to "nobody has reported".
    condition: conditionRaw === null ? null : oneOf(conditionRaw, CONDITION_VALUES),
  };

  // Safe-list of SET fragments — field names never interpolated dynamically.
  const setters: Record<string, (v: JsonValue) => SQL> = {
    name: (v) => sql`name = ${v}`,
    quarter: (v) => sql`quarter = ${v}`,
    // sql.param binds the list as one array parameter. Without it drizzle
    // expands the array to `($1, $2)::text[]`, which Postgres rejects — so
    // saving a facility with two or more sports failed.
    sport_types: (v) => sql`sport_types = ${sql.param(v as string[])}::text[]`,
    surface: (v) => sql`surface = ${v}`,
    lighting: (v) => sql`lighting = ${v}`,
    covered: (v) => sql`covered = ${v}`,
    access: (v) => sql`access = ${String(v)}::facility_access`,
    // The condition and its timestamp travel together (facilities_condition_pair).
    // An operator setting it is a fresh report as of now.
    condition: (v) =>
      v === null
        ? sql`condition = NULL, condition_reported_at = NULL`
        : sql`condition = ${String(v)}::facility_condition, condition_reported_at = now()`,
  };

  const db = getDb();

  // A number of applied changes, or 'refused' when a pin move was out of scope.
  const outcome = await db.transaction(async (tx): Promise<number | 'refused'> => {
    // The scope is part of the row lock: an out-of-scope facility simply is not
    // found, so the edit never begins.
    const currentResult = await tx.execute(sql`
      SELECT f.name, f.quarter, f.sport_types, f.surface, f.lighting, f.covered,
             f.access, f.condition::text AS condition, f.municipality_id,
             ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat
      FROM facilities f WHERE f.id = ${facilityId} AND ${scope}
      FOR UPDATE
    `);
    const row = currentResult.rows[0] as Record<string, JsonValue> | undefined;
    if (!row) throw new Error('facility not found');

    let appliedCount = 0;

    /**
     * MOVING THE PIN, first — so a refused move returns before anything else is
     * written. The municipality is recomputed from the new point in the same
     * statement (the importers' rule), so it can never disagree with the map.
     * An ambassador may only move a facility to somewhere still inside their
     * own municipalities: otherwise a move would hand a facility to (or take
     * one from) another ambassador, or drop it outside every boundary, where
     * nobody moderates it.
     */
    const was = { lon: Number(row.lon), lat: Number(row.lat) };
    if (location && locationChanged(was, location)) {
      const point = sql`ST_SetSRID(ST_MakePoint(${location.lon}::float8, ${location.lat}::float8), 4326)`;
      const placed = sql`(SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ${point}) ORDER BY m.id LIMIT 1)`;
      const targetScope =
        user.role === 'admin'
          ? sql`TRUE`
          : sql`${placed} IN (SELECT municipality_id FROM ambassador_municipalities WHERE user_id = ${user.id})`;
      const moved = await tx.execute(sql`
        UPDATE facilities f SET geom = ${point}, municipality_id = ${placed}
        WHERE f.id = ${facilityId} AND ${scope} AND ${targetScope}
        RETURNING f.municipality_id
      `);
      const movedRow = moved.rows[0] as Record<string, JsonValue> | undefined;
      if (!movedRow) return 'refused';
      // Same field name and value shape the OSM and municipal importers write,
      // so the merge policy sees an operator's move as a crowd edit of `geom`
      // and no later import drags the pin back.
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
        VALUES (${facilityId}, ${actor}, 'crowd', 'geom',
                ${JSON.stringify(was)}::jsonb, ${JSON.stringify(location)}::jsonb)
      `);
      appliedCount += 1;
      const before = row.municipality_id ?? null;
      const after = movedRow.municipality_id ?? null;
      if (before !== after) {
        await tx.execute(sql`
          INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
          VALUES (${facilityId}, ${actor}, 'crowd', 'municipality_id',
                  ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)
        `);
      }
    }

    const current: Record<string, JsonValue> = {
      name: row.name ?? null,
      quarter: row.quarter ?? null,
      sport_types: (row.sport_types as string[] | null) ?? [],
      surface: row.surface ?? null,
      lighting: row.lighting ?? null,
      covered: row.covered ?? false,
      access: row.access ?? null,
      condition: row.condition ?? null,
    };

    // crowd outranks everything, so nothing can be frozen against this edit;
    // mergeFields still gives change detection + audit payloads.
    const merge = mergeFields({ incomingSource: 'crowd', current, incoming, lastEditSources: {} });
    appliedCount += merge.applied.length;
    if (merge.applied.length === 0) return appliedCount;

    const fragments = merge.applied.map((change) => {
      const setter = setters[change.field];
      if (!setter) throw new Error(`unexpected field ${change.field}`);
      return setter(change.newValue);
    });
    await tx.execute(
      sql`UPDATE facilities f SET ${sql.join(fragments, sql`, `)}
          WHERE f.id = ${facilityId} AND ${scope}`,
    );

    for (const change of merge.applied) {
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
        VALUES (${facilityId}, ${actor}, 'crowd', ${change.field},
                ${JSON.stringify(change.oldValue)}::jsonb, ${JSON.stringify(change.newValue)}::jsonb)
      `);
    }
    return appliedCount;
  });

  if (outcome === 'refused') return { error: 'scope' };
  // The list is ordered by updated_at, and the editor's own history and
  // municipality line come from the rows just written: both re-render, while
  // the form keeps what is in it. The URL — and its ?back= — stays as it was.
  revalidatePath('/admin/facilities');
  return { error: null, saved: outcome };
}
