import { sql } from '@sportkarta/db';
import { POINTS_BY_EVENT } from '@sportkarta/lib/points';
import { afterAll, describe, expect, it } from 'vitest';

import { addFacility, type AddFacilityInput } from '@/lib/contributions/add-facility';
import { verifyFacility } from '@/lib/contributions/verify-facility';

import { closePool, FAR_AWAY, hasDb, journey, makeUser, one, sofiaPin, type Tx } from './db';

/**
 * Adding and verifying a facility (Stage 3.2), through the real functions
 * against real PostGIS. The statement-level companion is
 * tests/contributions.test.ts; this is the one that proves the SQL runs.
 */

function archeryRange(pin: { lat: number; lon: number }): AddFacilityInput {
  // Archery: rare enough that a jittered pin never lands on a real one.
  return {
    name: 'Journey archery range',
    quarter: '',
    sportTypes: ['archery'],
    access: 'free',
    ...pin,
  };
}

/** A crowd pin, added by `userId` from where it stands. */
async function addOnSite(tx: Tx, userId: string, pin: { lat: number; lon: number }) {
  return addFacility(tx, {
    userId,
    input: archeryRange(pin),
    photoStoragePath: `photos/journey-${userId}.webp`,
    position: pin,
  });
}

describe.skipIf(!hasDb)('contribution journeys (requires running database)', () => {
  afterAll(closePool);

  it('adds a crowd facility for moderation, pays the on-site author once, refuses a duplicate', async () => {
    await journey(async (tx) => {
      const author = await makeUser(tx, 'author');
      const pin = sofiaPin();
      const added = await addOnSite(tx, author, pin);

      expect(added).toMatchObject({ onSite: true, distanceM: 0, awarded: true });
      expect(added.slug).toMatch(/^journey-archery-range/);

      // Waiting for a second pair of eyes, attributed to the crowd, and placed
      // in its municipality by ST_Contains — without that it would be missing
      // from its city pages and the published statistics.
      const facility = await one(
        tx,
        sql`SELECT status, source, municipality_id, sport_types, slug
              FROM facilities WHERE id = ${added.facilityId}::uuid`,
      );
      expect(facility).toMatchObject({
        status: 'needs_verification',
        source: 'crowd',
        sport_types: ['archery'],
        slug: added.slug,
      });
      expect(facility?.municipality_id).not.toBeNull();

      // The audit row names the account and how far away it stood — metres,
      // never a coordinate.
      const edits = await tx.execute(
        sql`SELECT actor, source, field, distance_m FROM facility_edits
             WHERE facility_id = ${added.facilityId}::uuid`,
      );
      expect(edits.rows).toEqual([
        { actor: author, source: 'crowd', field: 'created', distance_m: 0 },
      ]);

      const photo = await one(
        tx,
        sql`SELECT status, uploaded_by FROM facility_photos WHERE facility_id = ${added.facilityId}::uuid`,
      );
      expect(photo).toEqual({ status: 'pending', uploaded_by: author });

      const ledger = await tx.execute(
        sql`SELECT points, idempotency_key FROM points_ledger WHERE user_id = ${author}`,
      );
      expect(ledger.rows).toEqual([
        {
          points: POINTS_BY_EVENT.facility_added,
          idempotency_key: `facility_added:${added.facilityId}`,
        },
      ]);

      // The same pin again, by anybody, is the same place — and the refusal
      // names the facility it collides with. The savepoint takes the attempt
      // back, so the journey carries on.
      const second = await makeUser(tx, 'second');
      await expect(addOnSite(tx, second, pin)).rejects.toMatchObject({
        code: 'duplicate_nearby',
        conflictSlug: added.slug,
      });
    });
  });

  it('pays nothing for a pin dropped without a position, and still files it', async () => {
    await journey(async (tx) => {
      const author = await makeUser(tx, 'armchair');
      const pin = sofiaPin();
      const added = await addFacility(tx, {
        userId: author,
        input: archeryRange(pin),
        photoStoragePath: `photos/journey-${author}.webp`,
        position: null,
      });

      expect(added).toMatchObject({ onSite: false, distanceM: null, awarded: false });
      const ledger = await one<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM points_ledger WHERE user_id = ${author}`,
      );
      expect(ledger?.n).toBe(0);
      const edit = await one(
        tx,
        sql`SELECT field, distance_m FROM facility_edits WHERE facility_id = ${added.facilityId}::uuid`,
      );
      expect(edit).toEqual({ field: 'created', distance_m: null });
    });
  });

  it('publishes only on a second, on-site confirmation — and pays that one', async () => {
    await journey(async (tx) => {
      const author = await makeUser(tx, 'claimant');
      const pin = sofiaPin();
      const { facilityId } = await addOnSite(tx, author, pin);

      // Nobody confirms their own claim.
      await expect(
        verifyFacility(tx, {
          userId: author,
          facilityId,
          checklist: { exists: true },
          position: pin,
        }),
      ).rejects.toMatchObject({ code: 'own_facility' });

      // From another city: the correction lands (an ordinary crowd edit, with
      // its distance), but nothing is published and nothing is paid.
      const remote = await makeUser(tx, 'remote');
      const far = await verifyFacility(tx, {
        userId: remote,
        facilityId,
        checklist: { exists: true, lighting: true },
        position: FAR_AWAY,
      });
      expect(far).toMatchObject({
        changedFields: ['lighting'],
        activated: false,
        awarded: false,
        onSite: false,
      });
      expect(far.distanceM).toBeGreaterThan(100_000);
      expect(
        await one(tx, sql`SELECT status, lighting FROM facilities WHERE id = ${facilityId}::uuid`),
      ).toEqual({ status: 'needs_verification', lighting: true });

      // Standing on it: published, recorded and paid.
      const local = await makeUser(tx, 'local');
      const near = await verifyFacility(tx, {
        userId: local,
        facilityId,
        checklist: { exists: true },
        position: pin,
      });
      expect(near).toMatchObject({ activated: true, awarded: true, onSite: true, distanceM: 0 });
      expect(
        await one(tx, sql`SELECT status FROM facilities WHERE id = ${facilityId}::uuid`),
      ).toEqual({ status: 'active' });

      const trail = await tx.execute(
        sql`SELECT actor, field, new_value FROM facility_edits
             WHERE facility_id = ${facilityId}::uuid AND actor <> ${author}
             ORDER BY id`,
      );
      expect(trail.rows).toEqual([
        { actor: remote, field: 'lighting', new_value: true },
        { actor: local, field: 'verified', new_value: true },
        { actor: local, field: 'status', new_value: 'active' },
      ]);

      const paid = await tx.execute(
        sql`SELECT user_id, points FROM points_ledger
             WHERE facility_id = ${facilityId}::uuid AND event = 'facility_verified'`,
      );
      expect(paid.rows).toEqual([{ user_id: local, points: POINTS_BY_EVENT.facility_verified }]);
    });
  });

  it('files "not there any more" as one pending report — never a deletion, never paid', async () => {
    await journey(async (tx) => {
      const author = await makeUser(tx, 'founder');
      const pin = sofiaPin();
      const { facilityId } = await addOnSite(tx, author, pin);

      for (const label of ['doubter', 'second-doubter']) {
        const doubter = await makeUser(tx, label);
        const result = await verifyFacility(tx, {
          userId: doubter,
          facilityId,
          checklist: { exists: false },
          position: pin,
        });
        expect(result).toMatchObject({ reportedMissing: true, awarded: false, activated: false });
      }

      // One person's word does not erase a facility from a national dataset…
      expect(
        await one(tx, sql`SELECT status FROM facilities WHERE id = ${facilityId}::uuid`),
      ).toEqual({ status: 'needs_verification' });
      // …and a second report does not flood the queue.
      const reports = await tx.execute(
        sql`SELECT issue, status FROM facility_reports WHERE facility_id = ${facilityId}::uuid`,
      );
      expect(reports.rows).toEqual([{ issue: 'does_not_exist', status: 'pending' }]);
      const paid = await one<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM points_ledger
             WHERE facility_id = ${facilityId}::uuid AND event = 'facility_verified'`,
      );
      expect(paid?.n).toBe(0);
    });
  });
});
