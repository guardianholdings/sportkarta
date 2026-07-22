import { sql, type SQL } from '@sportkarta/db';
import { CANONICAL_SPORTS, CANONICAL_SURFACES, mergeFields, type JsonValue } from '@sportkarta/lib';

import { awardPoints } from '../points';

import { ContributionError } from './errors';

/**
 * Verifying a facility (docs/ROADMAP.md §5, Stage 3.2).
 *
 * A structured checklist, not free text: the member confirms or corrects each
 * field, and every change lands in facility_edits with `source='crowd'` and the
 * account's opaque id as `actor`. Crowd outranks municipal and osm in the merge
 * policy, so these corrections survive the next import.
 *
 * "It is not there any more" deliberately does NOT set the status to `gone`.
 * One person's word should not erase a facility from a national dataset, so it
 * files a moderation report instead — and earns nothing, so there is no
 * incentive to claim it.
 */

const ACCESS_VALUES = ['free', 'paid', 'restricted', 'school'] as const;

export interface VerifyChecklist {
  /** false = "this facility is not there any more" → moderation, not deletion. */
  exists: boolean;
  access?: string | undefined;
  surface?: string | null | undefined;
  lighting?: boolean | null | undefined;
  covered?: boolean | undefined;
  sportTypes?: readonly string[] | undefined;
}

export interface VerifyResult {
  /** Fields the checklist actually changed. */
  changedFields: string[];
  /** True when the facility moved out of needs_verification. */
  activated: boolean;
  awarded: boolean;
  /** True when the member reported the facility as gone. */
  reportedMissing: boolean;
}

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** Pure: the checklist reduced to the fields a verification may touch. */
export function normalizeChecklist(checklist: VerifyChecklist): Record<string, JsonValue> {
  const incoming: Record<string, JsonValue> = {};

  if (checklist.access !== undefined) {
    if (!(ACCESS_VALUES as readonly string[]).includes(checklist.access)) {
      throw new ContributionError('invalid_access');
    }
    incoming.access = checklist.access;
  }

  if (checklist.surface !== undefined) {
    if (
      checklist.surface !== null &&
      !(CANONICAL_SURFACES as readonly string[]).includes(checklist.surface)
    ) {
      throw new ContributionError('invalid_surface');
    }
    incoming.surface = checklist.surface;
  }

  // Tri-state on purpose: null means "unknown", which is different from "no".
  if (checklist.lighting !== undefined) incoming.lighting = checklist.lighting;
  if (checklist.covered !== undefined) incoming.covered = checklist.covered;

  if (checklist.sportTypes !== undefined) {
    const sports = [...new Set(checklist.sportTypes)];
    if (sports.some((sport) => !(CANONICAL_SPORTS as readonly string[]).includes(sport))) {
      throw new ContributionError('invalid_sport');
    }
    if (sports.length === 0) throw new ContributionError('sports_required');
    // snake_case deliberately: this key becomes facility_edits.field, and the
    // importer's freeze lookup (scripts/import-osm MANAGED_FIELDS) and the admin
    // edit path both use 'sport_types'. A camelCase key here would leave crowd
    // corrections invisible to the merge policy, so the next OSM import would
    // silently overwrite them.
    incoming.sport_types = CANONICAL_SPORTS.filter((sport) => sports.includes(sport));
  }

  return incoming;
}

/** Column writers, mirroring the admin edit path. Field names are never interpolated. */
const SETTERS: Record<string, (value: JsonValue) => SQL> = {
  access: (v) => sql`access = ${v}::facility_access`,
  surface: (v) => sql`surface = ${v}`,
  lighting: (v) => sql`lighting = ${v}`,
  covered: (v) => sql`covered = ${v}`,
  sport_types: (v) => sql`sport_types = ${sql.param(v as string[])}::text[]`,
};

export async function verifyFacility(
  db: TransactionalDb,
  params: {
    userId: string;
    facilityId: string;
    checklist: VerifyChecklist;
    now?: Date;
  },
): Promise<VerifyResult> {
  const incoming = normalizeChecklist(params.checklist);

  return db.transaction(async (tx) => {
    const existing = await tx.execute(sql`
      SELECT access, surface, lighting, covered, sport_types, status
      FROM facilities WHERE id = ${params.facilityId}::uuid
    `);
    const row = existing.rows[0];
    if (!row) throw new ContributionError('facility_not_found');

    // A facility is published only after a SECOND pair of eyes. Without this,
    // one account could post a fabricated pin, be redirected straight to it,
    // confirm its own claim, and put it on the national map with points
    // attached — which is precisely what "needs_verification" exists to prevent.
    const author = await tx.execute(sql`
      SELECT 1 FROM facility_edits
      WHERE facility_id = ${params.facilityId}::uuid
        AND field = 'created'
        AND actor = ${params.userId}
      LIMIT 1
    `);
    if (author.rows.length > 0) throw new ContributionError('own_facility');

    if (!params.checklist.exists) {
      // Straight to the existing moderation queue; no field changes, no points.
      // De-duplicated against this account's own pending report so a repeat
      // submission cannot flood the queue for one facility.
      await tx.execute(sql`
        INSERT INTO facility_reports (facility_id, issue, body, status)
        SELECT ${params.facilityId}::uuid, 'does_not_exist', NULL, 'pending'
        WHERE NOT EXISTS (
          SELECT 1 FROM facility_reports r
          WHERE r.facility_id = ${params.facilityId}::uuid
            AND r.issue = 'does_not_exist'
            AND r.status = 'pending'
        )
      `);
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
        VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', 'reported_missing',
                NULL, 'true'::jsonb)
      `);
      return { changedFields: [], activated: false, awarded: false, reportedMissing: true };
    }

    const current: Record<string, JsonValue> = {
      access: (row.access as string | null) ?? null,
      surface: (row.surface as string | null) ?? null,
      lighting: (row.lighting as boolean | null) ?? null,
      covered: (row.covered as boolean | null) ?? false,
      sport_types: ((row.sport_types as string[] | null) ?? []) as JsonValue,
    };

    // Crowd outranks every other source, so nothing can be frozen against this
    // edit; mergeFields is here for change detection and audit payloads.
    const merge = mergeFields({
      incomingSource: 'crowd',
      current,
      incoming,
      lastEditSources: {},
    });

    if (merge.applied.length > 0) {
      const fragments = merge.applied.map((change) => {
        const setter = SETTERS[change.field];
        if (!setter) throw new Error(`unexpected field ${change.field}`);
        return setter(change.newValue);
      });
      await tx.execute(
        sql`UPDATE facilities SET ${sql.join(fragments, sql`, `)} WHERE id = ${params.facilityId}::uuid`,
      );
      for (const change of merge.applied) {
        await tx.execute(sql`
          INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
          VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', ${change.field},
                  ${JSON.stringify(change.oldValue)}::jsonb, ${JSON.stringify(change.newValue)}::jsonb)
        `);
      }
    } else {
      // A confirmation with no corrections is still evidence: record it, or the
      // audit trail would show nothing for the commonest contribution of all.
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
        VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', 'verified', NULL, 'true'::jsonb)
      `);
    }

    const activated = row.status === 'needs_verification';
    if (activated) {
      await tx.execute(sql`
        UPDATE facilities SET status = 'active'
        WHERE id = ${params.facilityId}::uuid AND status = 'needs_verification'
      `);
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
        VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', 'status',
                '"needs_verification"'::jsonb, '"active"'::jsonb)
      `);
    }

    const awarded = await awardPoints(tx, {
      userId: params.userId,
      event: 'facility_verified',
      facilityId: params.facilityId,
      ...(params.now ? { now: params.now } : {}),
    });

    return {
      changedFields: merge.applied.map((change) => change.field),
      activated,
      awarded,
      reportedMissing: false,
    };
  });
}
