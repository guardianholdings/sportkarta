import 'server-only';

import { getDb, sql, type SQL } from '@sportkarta/db';
import { CLUB_TIERS, isGaMeasurementId, isMetaPixelId, type ClubTier } from '@sportkarta/lib/clubs';

import { clubRenderableSql } from './access';
import { recordClubAudit } from './audit';
import { clubFeatureSql, clubSwitchOn, featureOn } from './features';
import { clubActorMay, clubStaffWriteScope, type ClubActor } from './scope';

/**
 * A paid club's own GA4 and Meta Pixel ids (wave H2, 0058). The rules are in
 * lib/src/clubs/tracking.ts; this is who may set them and who may see them.
 *
 *  - Set only by the club's OWN management (settings.manage via
 *    clubStaffWriteScope — never the NGO admin: a pixel makes the club a
 *    joint controller with the vendor), on a tier with pixels.
 *  - Read for rendering only on a club's PUBLIC pages, only while its tier
 *    has pixels AND the operator's CLUB_PIXELS_ENABLED is on, and only for a
 *    renderable club. The office, the portal and the rest of pops.bg never
 *    render them.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export interface ClubTracking {
  clubId: string;
  gaId: string | null;
  metaId: string | null;
  /** The club's own privacy notice, linked from the banner (0058 requires it with an id). */
  policyUrl: string | null;
}

/** What a public page loads after consent — or null: nothing to ask about. */
export async function publicClubTracking(clubId: string): Promise<ClubTracking | null> {
  // Switched off (as it ships): no query on any page view.
  if (!clubSwitchOn('pixels')) return null;
  const result = await getDb().execute(sql`
    SELECT c.tier, c.ga_measurement_id, c.meta_pixel_id, c.privacy_url FROM clubs c
     WHERE c.id = ${clubId}::uuid AND ${clubRenderableSql('c')}
       AND ${clubFeatureSql(clubId, 'pixels')}
  `);
  const row = result.rows[0];
  const tier = String(row?.tier);
  // The tier is the statement's; the operator's switch is the code's.
  if (!row || !(CLUB_TIERS as readonly string[]).includes(tier)) return null;
  if (!featureOn({ tier: tier as ClubTier }, 'pixels')) return null;
  const gaId = isGaMeasurementId(row.ga_measurement_id) ? row.ga_measurement_id : null;
  const metaId = isMetaPixelId(row.meta_pixel_id) ? row.meta_pixel_id : null;
  if (!gaId && !metaId) return null;
  return {
    clubId,
    gaId,
    metaId,
    policyUrl: typeof row.privacy_url === 'string' ? row.privacy_url : null,
  };
}

export interface ClubTrackingIds {
  gaId: string | null;
  metaId: string | null;
  /** The club's privacy notice — required while either id is set (0058). */
  privacyUrl: string | null;
}

/** The ids as the settings form shows them. */
export async function clubTrackingSettings(actor: ClubActor): Promise<ClubTrackingIds> {
  const result = await getDb().execute(sql`
    SELECT c.ga_measurement_id, c.meta_pixel_id, c.privacy_url FROM clubs c
     WHERE c.id = ${actor.clubId}::uuid
       AND ${clubActorMay(actor, 'settings.manage', { write: false })}
  `);
  const row = result.rows[0];
  return {
    gaId: typeof row?.ga_measurement_id === 'string' ? row.ga_measurement_id : null,
    metaId: typeof row?.meta_pixel_id === 'string' ? row.meta_pixel_id : null,
    privacyUrl: typeof row?.privacy_url === 'string' ? row.privacy_url : null,
  };
}

/**
 * Set or clear the ids and the notice (null clears). The club's own
 * management only. One statement, so 0058's "an id needs a notice" CHECK
 * sees the final row whichever way the change goes.
 */
export async function saveClubTracking(
  db: TransactionalDb,
  actor: ClubActor,
  ids: ClubTrackingIds,
): Promise<boolean> {
  if ((ids.gaId !== null || ids.metaId !== null) && ids.privacyUrl === null) return false;
  return db.transaction(async (tx) => {
    const saved = await tx.execute(sql`
      UPDATE clubs c
         SET ga_measurement_id = ${ids.gaId}, meta_pixel_id = ${ids.metaId},
             privacy_url = ${ids.privacyUrl}, updated_at = now()
        FROM club_staff st
       WHERE c.id = ${actor.clubId}::uuid AND st.club_id = c.id AND st.user_id = ${actor.userId}
         AND ${clubStaffWriteScope(actor, 'settings.manage', 'st')}
         AND ${clubFeatureSql(actor.clubId, 'pixels')}
      RETURNING c.id
    `);
    if (saved.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'settings_changed',
      detail: {
        tracking: true,
        ga: ids.gaId !== null,
        meta: ids.metaId !== null,
        privacy: ids.privacyUrl !== null,
      },
    });
    return true;
  });
}
