'use server';

import { getDb, sql, type SQL } from '@sportkarta/db';
import { CANONICAL_SPORTS, CANONICAL_SURFACES, mergeFields, type JsonValue } from '@sportkarta/lib';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ACCESS_VALUES, isUuid, STATUS_VALUES } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/auth-session';

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

/**
 * Operator edit: every applied change is one facility_edits audit row with
 * actor (from the verified session, never from the form) and source='crowd' —
 * top merge-policy priority, so these fields freeze against OSM re-imports.
 */
export async function saveFacility(facilityId: string, formData: FormData): Promise<void> {
  const { id: actor } = await requireAdmin();
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

  const incoming: Record<string, JsonValue> = {
    name: optionalText(formData.get('name')),
    quarter: optionalText(formData.get('quarter')),
    sport_types: sports,
    surface: surfaceRaw === null ? null : oneOf(surfaceRaw, CANONICAL_SURFACES),
    lighting: lightingRaw === 'yes' ? true : lightingRaw === 'no' ? false : null,
    covered: formData.get('covered') === 'on',
    access: oneOf(formData.get('access'), ACCESS_VALUES),
    status: oneOf(formData.get('status'), STATUS_VALUES),
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
    status: (v) => sql`status = ${String(v)}::facility_status`,
  };

  const db = getDb();
  let appliedCount = 0;

  await db.transaction(async (tx) => {
    const currentResult = await tx.execute(sql`
      SELECT name, quarter, sport_types, surface, lighting, covered, access, status
      FROM facilities WHERE id = ${facilityId} FOR UPDATE
    `);
    const row = currentResult.rows[0] as Record<string, JsonValue> | undefined;
    if (!row) throw new Error('facility not found');

    const current: Record<string, JsonValue> = {
      name: row.name ?? null,
      quarter: row.quarter ?? null,
      sport_types: (row.sport_types as string[] | null) ?? [],
      surface: row.surface ?? null,
      lighting: row.lighting ?? null,
      covered: row.covered ?? false,
      access: row.access ?? null,
      status: row.status ?? null,
    };

    // crowd outranks everything, so nothing can be frozen against this edit;
    // mergeFields still gives change detection + audit payloads.
    const merge = mergeFields({ incomingSource: 'crowd', current, incoming, lastEditSources: {} });
    appliedCount = merge.applied.length;
    if (merge.applied.length === 0) return;

    const fragments = merge.applied.map((change) => {
      const setter = setters[change.field];
      if (!setter) throw new Error(`unexpected field ${change.field}`);
      return setter(change.newValue);
    });
    await tx.execute(
      sql`UPDATE facilities SET ${sql.join(fragments, sql`, `)} WHERE id = ${facilityId}`,
    );

    for (const change of merge.applied) {
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
        VALUES (${facilityId}, ${actor}, 'crowd', ${change.field},
                ${JSON.stringify(change.oldValue)}::jsonb, ${JSON.stringify(change.newValue)}::jsonb)
      `);
    }
  });

  revalidatePath('/admin/facilities');
  redirect(`/admin/facilities/${facilityId}?saved=${String(appliedCount)}`);
}
