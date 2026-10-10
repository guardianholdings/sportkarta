import { sql, type SQL } from '@sportkarta/db';
import { CANONICAL_SPORTS, CANONICAL_SURFACES, mergeFields, type JsonValue } from '@sportkarta/lib';

import { awardPoints } from '../points';
import { type Coordinates, distanceToGeomSql, isOnSite, parseCoordinates } from './proximity';

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
  /** Metres from the facility, or null when no position was offered. */
  distanceM?: number | null;
  /** Whether the confirmer was close enough to publish and to be paid. */
  onSite?: boolean;
  /** Fields the checklist actually changed. */
  changedFields: string[];
  /** True when the facility moved out of needs_verification. */
  activated: boolean;
  awarded: boolean;
  /** True when the member reported the facility as gone. */
  reportedMissing: boolean;
  /**
   * True when a change of access to a value that hides the facility was filed
   * for a moderator instead of being applied (see gateHidingAccessChange).
   */
  accessProposed?: boolean;
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

/**
 * Access values the public visibility predicate HIDES. PUBLIC_FACILITY_PREDICATE
 * (lib/src/opendata/schema.ts) drops `paid` rows while `public_show_paid` is
 * off; `school` and `restricted` stay on the map. A test holds the two
 * together, so widening the predicate without widening this fails CI.
 */
export const PUBLIC_HIDDEN_ACCESS: readonly string[] = ['paid'];

/**
 * A CROWD CHANGE THAT WOULD HIDE A FACILITY IS A PROPOSAL, NOT AN EDIT.
 *
 * `access` is the one field whose wrong value takes a facility off the map, the
 * city pages, the sitemap and the open-data export — and crowd outranks every
 * import, so no re-import would bring it back (pre-launch audit finding 53).
 * Nobody reports a facility they cannot see.
 *
 * So the gate is on the OUTCOME, not on the contributor: any change TO a hiding
 * value is recorded as an `access_proposed` audit row — attributed, with its
 * distance — and a pending moderation report is filed (one per facility), and a
 * moderator decides in the editor. Whatever the current value is (a `school` or
 * `restricted` pitch is just as visible as a free one), and whether or not the
 * member was on site: `onSite` comes from coordinates the browser sends, every
 * facility's own coordinates are published, so a script can claim to be
 * standing at each one (proximity.ts: evidence, never proof). Every other
 * correction, and any change that keeps a facility visible — including back TO
 * free — still applies as before.
 */
function gateHidingAccessChange(
  incoming: Record<string, JsonValue>,
  currentAccess: JsonValue,
): { proposed: JsonValue } | null {
  const proposed = incoming.access;
  if (typeof proposed !== 'string' || proposed === currentAccess) return null;
  if (!PUBLIC_HIDDEN_ACCESS.includes(proposed)) return null;
  delete incoming.access;
  return { proposed };
}

/** Column writers, mirroring the admin edit path. Field names are never interpolated. */
const SETTERS: Record<string, (value: JsonValue) => SQL> = {
  access: (v) => sql`access = ${v}::facility_access`,
  surface: (v) => sql`surface = ${v}`,
  lighting: (v) => sql`lighting = ${v}`,
  covered: (v) => sql`covered = ${v}`,
  sport_types: (v) => sql`sport_types = ${sql.param(v as string[])}::text[]`,
};

/**
 * Whether this account added the facility — the one thing `verifyFacility`
 * refuses outright (`own_facility`). Asked by the facility page BEFORE it
 * renders the checklist: the author used to land on it straight after adding,
 * fill it in, and only then be told no (UX audit 2026-10-10). Same query as
 * the guard inside the transaction, which stays the authority.
 */
export async function isFacilityAuthor(
  db: { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> },
  facilityId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM facility_edits
    WHERE facility_id = ${facilityId}::uuid
      AND field = 'created'
      AND actor = ${userId}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

export async function verifyFacility(
  db: TransactionalDb,
  params: {
    userId: string;
    facilityId: string;
    checklist: VerifyChecklist;
    /** Where the contributor was standing, if they offered it. */
    position?: { lat: unknown; lon: unknown } | null;
    now?: Date;
  },
): Promise<VerifyResult> {
  const incoming = normalizeChecklist(params.checklist);
  const coords: Coordinates | null = params.position
    ? parseCoordinates(params.position.lat, params.position.lon)
    : null;

  return db.transaction(async (tx) => {
    const existing = await tx.execute(sql`
      SELECT access, surface, lighting, covered, sport_types, status,
             ${distanceToGeomSql(sql`geom`, coords)} AS distance_m
      FROM facilities WHERE id = ${params.facilityId}::uuid
    `);
    const row = existing.rows[0];
    if (!row) throw new ContributionError('facility_not_found');
    const distanceM =
      row.distance_m === null || row.distance_m === undefined ? null : Number(row.distance_m);
    const onSite = isOnSite(distanceM);

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

    const accessProposal = gateHidingAccessChange(incoming, current.access ?? null);
    if (accessProposal) {
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value, distance_m)
        VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', 'access_proposed',
                ${JSON.stringify(current.access)}::jsonb,
                ${JSON.stringify(accessProposal.proposed)}::jsonb, ${distanceM})
      `);
      // Into the existing moderation queue, de-duplicated per facility so a
      // repeat submission cannot flood it.
      await tx.execute(sql`
        INSERT INTO facility_reports (facility_id, issue, body, status, distance_m)
        SELECT ${params.facilityId}::uuid, 'other', NULL, 'pending', ${distanceM}
        WHERE NOT EXISTS (
          SELECT 1 FROM facility_reports r
          WHERE r.facility_id = ${params.facilityId}::uuid
            AND r.issue = 'other'
            AND r.status = 'pending'
        )
      `);
    }

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
          INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value, distance_m)
          VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', ${change.field},
                  ${JSON.stringify(change.oldValue)}::jsonb, ${JSON.stringify(change.newValue)}::jsonb,
                  ${distanceM})
        `);
      }
    } else {
      // A confirmation with no corrections is still evidence: record it, or the
      // audit trail would show nothing for the commonest contribution of all.
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value, distance_m)
        VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', 'verified', NULL, 'true'::jsonb,
                ${distanceM})
      `);
    }

    /**
     * PUBLISHING IS WHAT PROXIMITY REALLY GATES.
     *
     * This is the step that moves a facility out of `needs_verification` and on
     * to the national map, and it was the cheapest fake on the platform: confirm
     * somebody's fabricated pin from an armchair and it goes live. Requiring the
     * confirmer to have been standing there does not make the claim true, but it
     * makes publishing cost a trip — and a remote confirmation is still recorded
     * (with its distance) so a moderator can see the corroboration and decide.
     *
     * The field CORRECTIONS above are applied either way: those are ordinary
     * crowd edits under the merge policy, they are individually attributed, and
     * withholding them would lose real fixes to protect against a fake nobody
     * has demonstrated. The one exception is a change of access that would
     * hide the facility, which is gated above (gateHidingAccessChange).
     */
    const activated = row.status === 'needs_verification' && onSite;
    if (activated) {
      await tx.execute(sql`
        UPDATE facilities SET status = 'active'
        WHERE id = ${params.facilityId}::uuid AND status = 'needs_verification'
      `);
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value, distance_m)
        VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', 'status',
                '"needs_verification"'::jsonb, '"active"'::jsonb, ${distanceM})
      `);
    }

    const awarded = onSite
      ? await awardPoints(tx, {
          userId: params.userId,
          event: 'facility_verified',
          facilityId: params.facilityId,
          ...(params.now ? { now: params.now } : {}),
        })
      : false;

    return {
      changedFields: merge.applied.map((change) => change.field),
      activated,
      awarded,
      reportedMissing: false,
      distanceM,
      onSite,
      ...(accessProposal ? { accessProposed: true } : {}),
    };
  });
}
