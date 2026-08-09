import { sql, type SQL } from '@sportkarta/db';
import { CANONICAL_SPORTS, facilitySlug, slugify } from '@sportkarta/lib';
import { BULGARIA_BBOX, insideBulgaria } from '@sportkarta/lib/geo';

import { awardPoints } from '../points';
import { type Coordinates, distanceToPointSql, isOnSite, parseCoordinates } from './proximity';

import { ContributionError } from './errors';

/**
 * Adding a facility (docs/ROADMAP.md §5, Stage 3.2).
 *
 * A crowd addition lands as `status=needs_verification`, `source=crowd`: it
 * appears on the map only after a second pair of eyes, and the merge policy
 * (crowd > municipal > osm) means a later import can never quietly overwrite
 * it. A photo is mandatory — an unphotographed pin is a claim, and this dataset
 * is meant to be checkable.
 */

const ACCESS_VALUES = ['free', 'paid', 'restricted', 'school'] as const;
export type AccessValue = (typeof ACCESS_VALUES)[number];

export const NAME_MAX = 120;
export const QUARTER_MAX = 80;

/**
 * The country bounding box the facilities table enforces (migration 0001).
 * Checked here too so a mis-dragged pin gets an explanation instead of a
 * constraint violation.
 */
// One definition, in @sportkarta/lib/geo — re-exported so existing importers
// of this name keep working.
export { BULGARIA_BBOX };

/** Two pins closer than this, sharing a sport, are treated as the same place. */
export const DUPLICATE_RADIUS_METRES = 30;

export interface AddFacilityInput {
  name: string;
  quarter: string;
  sportTypes: readonly string[];
  access: string;
  lon: number;
  lat: number;
}

export interface NormalizedFacility {
  name: string | null;
  quarter: string | null;
  sportTypes: string[];
  access: AccessValue;
  lon: number;
  lat: number;
}

/** Pure validation, so the rules are testable without a database. */
export function normalizeAddFacility(input: AddFacilityInput): NormalizedFacility {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length > NAME_MAX) throw new ContributionError('name_too_long');

  const quarter = input.quarter.trim().replace(/\s+/g, ' ');
  if (quarter.length > QUARTER_MAX) throw new ContributionError('name_too_long');

  const sportTypes = [...new Set(input.sportTypes)].filter((sport) =>
    (CANONICAL_SPORTS as readonly string[]).includes(sport),
  );
  if (sportTypes.length === 0) throw new ContributionError('sports_required');
  if (sportTypes.length !== new Set(input.sportTypes).size) {
    throw new ContributionError('invalid_sport');
  }

  if (!(ACCESS_VALUES as readonly string[]).includes(input.access)) {
    throw new ContributionError('invalid_access');
  }

  if (!Number.isFinite(input.lon) || !Number.isFinite(input.lat)) {
    throw new ContributionError('invalid_coordinates');
  }
  if (!insideBulgaria({ lon: input.lon, lat: input.lat })) {
    throw new ContributionError('outside_bulgaria');
  }

  return {
    name: name || null,
    quarter: quarter || null,
    sportTypes: CANONICAL_SPORTS.filter((sport) => sportTypes.includes(sport)),
    access: input.access as AccessValue,
    // Six decimals ≈ 0.1 m: precise enough for a pitch, and it keeps the stored
    // coordinate from implying accuracy a phone GPS does not have.
    lon: Number(input.lon.toFixed(6)),
    lat: Number(input.lat.toFixed(6)),
  };
}

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export interface AddFacilityResult {
  /** Metres from the dropped pin, or null when no position was offered. */
  distanceM?: number | null;
  /** Whether the contributor was close enough to be trusted (and paid). */
  onSite?: boolean;
  facilityId: string;
  slug: string;
  awarded: boolean;
}

/**
 * Reject a pin that duplicates an existing facility of the same sport within
 * DUPLICATE_RADIUS_METRES. Geography casts give true metres, so the radius does
 * not stretch with latitude.
 */
async function findNearbyDuplicate(
  db: SqlRunner,
  facility: NormalizedFacility,
): Promise<string | null> {
  // Two-stage on purpose: the geometry predicate can use facilities_geom_gist
  // (a geography cast cannot), and the geography distance then makes the radius
  // exact metres rather than degrees. ~0.0005° comfortably covers 30 m at
  // Bulgarian latitudes, so nothing real is filtered out before the exact test.
  const result = await db.execute(sql`
    SELECT slug, id FROM facilities
    WHERE status <> 'gone'
      AND sport_types && ${sql.param(facility.sportTypes)}::text[]
      AND ST_DWithin(
            geom,
            ST_SetSRID(ST_MakePoint(${facility.lon}, ${facility.lat}), 4326),
            0.0005
          )
      AND ST_DistanceSphere(
            geom,
            ST_SetSRID(ST_MakePoint(${facility.lon}, ${facility.lat}), 4326)
          ) <= ${DUPLICATE_RADIUS_METRES}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return (row.slug as string | null) ?? String(row.id);
}

export async function addFacility(
  db: TransactionalDb,
  params: {
    userId: string;
    input: AddFacilityInput;
    /** Storage key of the already-processed (EXIF-stripped) photo. */
    photoStoragePath: string;
    /**
     * Where the contributor was standing, if they offered it. Measured against
     * THE PIN THEY DROPPED rather than against anything already on the map —
     * "you must be at the place you are marking" is the only sensible reading
     * for a facility that does not exist yet.
     */
    position?: { lat: unknown; lon: unknown } | null;
    now?: Date;
  },
): Promise<AddFacilityResult> {
  const facility = normalizeAddFacility(params.input);
  if (!params.photoStoragePath) throw new ContributionError('photo_required');
  // A missing or unparseable fix degrades to "no location", never to an error:
  // a broken GPS must not cost somebody their contribution.
  const coords: Coordinates | null = params.position
    ? parseCoordinates(params.position.lat, params.position.lon)
    : null;

  return db.transaction(async (tx) => {
    // Inside the transaction: two concurrent submissions of the same pin would
    // otherwise both pass a check made before either insert. Not airtight
    // without an exclusion constraint, but the window shrinks to a statement.
    const duplicate = await findNearbyDuplicate(tx, facility);
    if (duplicate) throw new ContributionError('duplicate_nearby', duplicate);

    // The municipality is derived here, exactly as the importer does it at
    // insert time. Without it a crowd-added facility is missing from its city
    // and quarter pages, from the sitemap, and from the municipality statistics
    // the NGO publishes — until someone happens to run a full OSM import.
    const inserted = await tx.execute(sql`
      INSERT INTO facilities (geom, name, quarter, sport_types, access, status, source, municipality_id)
      VALUES (
        ST_SetSRID(ST_MakePoint(${facility.lon}, ${facility.lat}), 4326),
        ${facility.name},
        ${facility.quarter},
        ${sql.param(facility.sportTypes)}::text[],
        ${facility.access}::facility_access,
        'needs_verification',
        'crowd',
        (SELECT m.id FROM municipalities m
          WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(${facility.lon}, ${facility.lat}), 4326))
          LIMIT 1)
      )
      RETURNING id
    `);
    const facilityId = String(inserted.rows[0]?.id);

    // Slug is assigned once, at creation, and never regenerated on rename —
    // public links have to stay stable (migration 0002). Only slugs that could
    // actually collide are fetched, rather than the whole national table.
    const base = slugify(facility.name ?? '') || slugify(facilityId) || 'obekt';
    const candidates = await tx.execute(sql`
      SELECT slug FROM facilities
      WHERE slug = ${base} OR slug LIKE ${`${base}-%`}
    `);
    const takenSlugs = new Set(candidates.rows.map((row) => String(row.slug)));
    const preferred = facilitySlug(facility.name, facilityId, (candidate) =>
      takenSlugs.has(candidate),
    );
    // Two concurrent adds of the same name can pick the same slug between the
    // read above and this write, and a unique violation would abort the whole
    // transaction (a caught error cannot be recovered from without a savepoint).
    // So the choice is made atomically in one statement, falling back to an
    // id-derived slug that cannot collide.
    const fallback = `${base}-${facilityId.slice(0, 8)}`;
    const slugged = await tx.execute(sql`
      UPDATE facilities SET slug = COALESCE(
        (SELECT ${preferred}::text
          WHERE NOT EXISTS (SELECT 1 FROM facilities WHERE slug = ${preferred})),
        ${fallback}::text
      )
      WHERE id = ${facilityId}::uuid
      RETURNING slug
    `);
    const slug = String(slugged.rows[0]?.slug ?? fallback);

    await tx.execute(sql`
      INSERT INTO facility_photos (facility_id, storage_path, status, uploaded_by)
      VALUES (${facilityId}::uuid, ${params.photoStoragePath}, 'pending', ${params.userId})
    `);

    // The audit row carries what was claimed, attributed to the account, and how
    // far away its author was. The distance is computed in SQL from coordinates
    // that exist only for this statement — nothing writes a latitude anywhere.
    const measured = await tx.execute(sql`
      INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value, distance_m)
      VALUES (${facilityId}::uuid, ${params.userId}, 'crowd', 'created', NULL,
              ${JSON.stringify({
                name: facility.name,
                quarter: facility.quarter,
                sport_types: facility.sportTypes,
                access: facility.access,
              })}::jsonb,
              ${distanceToPointSql({ lat: facility.lat, lon: facility.lon }, coords)})
      RETURNING distance_m
    `);
    const distanceM =
      measured.rows[0]?.distance_m === null || measured.rows[0]?.distance_m === undefined
        ? null
        : Number(measured.rows[0].distance_m);
    const onSite = isOnSite(distanceM);

    /**
     * POINTS ARE THE ONLY THING PROXIMITY GATES HERE.
     *
     * The facility is inserted either way, and it was already landing as
     * `needs_verification` — a crowd addition has always waited for a human, so
     * there is no status left to withhold. What changes is the reward: a pin
     * dropped from the next city earns nothing, which is what makes filing a
     * hundred of them pointless, while the pin itself still reaches the queue
     * where a moderator can judge it on its merits (and can now see how far away
     * its author was).
     */
    const awarded = onSite
      ? await awardPoints(tx, {
          userId: params.userId,
          event: 'facility_added',
          facilityId,
          ...(params.now ? { now: params.now } : {}),
        })
      : false;

    return { facilityId, slug, awarded, distanceM, onSite };
  });
}
