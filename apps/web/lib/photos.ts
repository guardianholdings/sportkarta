import { publicFacilityVisible, sql, type SQL } from '@sportkarta/db';

import { scopeClause, type ModerationActor } from './moderation';
import { canAccessAdminPanel } from './roles';

/**
 * Facility photos: which file may leave the building, and to whom.
 *
 * THE ROW DECIDES, NOT THE PATH — the rule /api/partners/logo/[id] and the
 * open-data dumps already follow. A photo is addressed by its facility_photos
 * id (lib/photo-url.ts); the storage key comes from that row, so traversal is
 * unexpressible and a file no row points at is unreachable. Every upload lands
 * on the volume the moment it is made — pending, unmoderated, possibly showing
 * a child — so the volume itself is never served, and this module is the only
 * place the answer "may this viewer have this file?" is written.
 *
 *   - Anyone: an APPROVED photo of a facility the public map shows. The facility
 *     half is `publicFacilityVisible`, the same predicate the map, the facility
 *     pages and the open-data export use, so a photo cannot be public while its
 *     facility is not.
 *   - A moderator (ambassador or admin): any photo — pending, approved or
 *     rejected — of a facility inside their moderation scope, the same
 *     `scopeClause` the decisions carry. An ambassador can see exactly the
 *     photos they can decide, and no others.
 *   - Everybody else: 404, identical to "no such photo", so the route is not an
 *     oracle for which ids exist or are awaiting review.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE PUBLIC RULE, WRITTEN ONCE. Embedded by the serving route and by the
 * facility page's photo list (lib/public-data.ts), so the page never lists a
 * photo the route would then refuse — a list and a route that disagreed would
 * put a broken image on a public page.
 *
 * CONVENTION: aliases `p` (facility_photos) and `f` (facilities), like
 * scopeClause and PARTNER_RENDERABLE. A missing alias is a loud SQL error.
 */
export const PHOTO_PUBLIC: SQL = sql`p.status = 'approved' AND ${publicFacilityVisible}`;

export type PhotoAudience = 'public' | 'moderator';

export interface ServablePhoto {
  storagePath: string;
  audience: PhotoAudience;
}

/**
 * Resolve a photo id to the file this viewer may receive, or null.
 *
 * `viewer` is called ONLY when the photo is not public, so the common case — a
 * visitor loading an approved photo on a facility page — costs one indexed
 * lookup and never touches the session.
 */
export async function resolveServablePhoto(
  db: SqlRunner,
  photoId: string,
  viewer: () => Promise<ModerationActor | null>,
): Promise<ServablePhoto | null> {
  if (!UUID_RE.test(photoId)) return null;

  const publicRow = await db.execute(sql`
    SELECT p.storage_path
      FROM facility_photos p
      JOIN facilities f ON f.id = p.facility_id
     WHERE p.id = ${photoId}::uuid AND ${PHOTO_PUBLIC}
  `);
  const publicPath = publicRow.rows[0]?.storage_path;
  if (publicPath) return { storagePath: String(publicPath), audience: 'public' };

  const actor = await viewer();
  if (!actor || !canAccessAdminPanel(actor.role)) return null;

  // Scope in the statement, not in a check before it (lib/moderation.ts): a
  // scopeless ambassador's predicate is FALSE and this returns nothing.
  const scopedRow = await db.execute(sql`
    SELECT p.storage_path
      FROM facility_photos p
      JOIN facilities f ON f.id = p.facility_id
     WHERE p.id = ${photoId}::uuid AND ${scopeClause(actor)}
  `);
  const scopedPath = scopedRow.rows[0]?.storage_path;
  return scopedPath ? { storagePath: String(scopedPath), audience: 'moderator' } : null;
}

/**
 * Response headers per audience.
 *
 * Public: an hour, and deliberately no stale-while-revalidate. The bytes behind
 * an id never change, but visibility can be WITHDRAWN (a takedown), and a
 * withdrawn photo must stop being served within a bounded, short time.
 *
 * Moderator: never stored anywhere. A pending photo is unreviewed by
 * definition; it must not land in a shared cache, and not in the moderator's
 * disk cache on a borrowed or shared computer either.
 *
 * Always image/webp: every stored photo is the re-encoded output of
 * lib/image.ts. nosniff so no browser second-guesses that from the bytes.
 */
export function photoResponseHeaders(audience: PhotoAudience): Record<string, string> {
  return {
    'Content-Type': 'image/webp',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': audience === 'public' ? 'public, max-age=3600' : 'private, no-store',
  };
}

/** How a moderator names the photo to take down; see parsePhotoLookup. */
export type PhotoLookup = { kind: 'id'; id: string } | { kind: 'slug'; slug: string };

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FACILITY_PATH = /\/obekt\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[/?#]|$)/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Turn whatever a takedown request arrives with into a lookup. A complaint
 * usually carries a link, so all of these work, pasted as-is:
 *   - the photo's own address, /api/photos/<id> ("copy image address")
 *   - the public facility page, /obekt/<slug> (with or without /en, a host)
 *   - the admin facility page, /admin/facilities/<id>, or a bare id or slug
 * A uuid matches a photo id OR a facility id (photosLookupClause), which is why
 * one kind covers both admin links. Returns null for an empty box and
 * 'invalid' for text that names neither.
 */
export function parsePhotoLookup(raw: string): PhotoLookup | 'invalid' | null {
  const text = raw.trim();
  if (text === '') return null;
  if (text.length > 500) return 'invalid';
  const uuid = UUID_IN_TEXT.exec(text);
  if (uuid) return { kind: 'id', id: uuid[0].toLowerCase() };
  const slug = FACILITY_PATH.exec(text)?.[1] ?? (SLUG_RE.test(text) ? text : null);
  return slug ? { kind: 'slug', slug } : 'invalid';
}

/** The lookup as a predicate; aliases `p` and `f` like PHOTO_PUBLIC. */
export function photosLookupClause(lookup: PhotoLookup | null): SQL {
  if (!lookup) return sql`TRUE`;
  if (lookup.kind === 'slug') return sql`f.slug = ${lookup.slug}`;
  return sql`(p.id = ${lookup.id}::uuid OR p.facility_id = ${lookup.id}::uuid)`;
}
