import { sql } from '@sportkarta/db';
import { afterAll, describe, expect, it } from 'vitest';

import { addFacility } from '@/lib/contributions/add-facility';
import { verifyFacility } from '@/lib/contributions/verify-facility';
import { decideFacility, decidePhoto, type PhotoFiles, resolveReport } from '@/lib/moderation';

import { closePool, hasDb, journey, makeUser, one, sofiaPin } from './db';

/**
 * Municipality-scoped moderation (Stage 3.3), through the real decide*
 * functions against real PostGIS. db/src/moderation-authz.test.ts proves the
 * scope predicate with a hand-copied statement; this proves the statements the
 * moderation screen actually runs — scope, state guard and the append-only
 * decision log together.
 */

/** Records which photo files a decision asked storage to delete. */
function recordingFiles(): PhotoFiles & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    delete: (key) => {
      deleted.push(key);
      return Promise.resolve();
    },
  };
}

describe.skipIf(!hasDb)('moderation journey (requires running database)', () => {
  afterAll(closePool);

  it('decides only inside the ambassador’s municipalities, once, and logs every decision', async () => {
    await journey(async (tx) => {
      // A crowd pin with its photo, a second photo of it, and a "not there
      // any more" report on it.
      const author = await makeUser(tx, 'contributor');
      const doubter = await makeUser(tx, 'doubter');
      const pin = sofiaPin();
      const keptPath = `photos/journey-${author}.webp`;
      const refusedPath = `photos/journey-${author}-2.webp`;
      const { facilityId } = await addFacility(tx, {
        userId: author,
        input: { name: '', quarter: '', sportTypes: ['archery'], access: 'free', ...pin },
        photoStoragePath: keptPath,
        position: pin,
      });
      const second = await one<{ id: string }>(
        tx,
        sql`INSERT INTO facility_photos (facility_id, storage_path, status, uploaded_by)
            VALUES (${facilityId}::uuid, ${refusedPath}, 'pending', ${author})
            RETURNING id`,
      );
      await verifyFacility(tx, { userId: doubter, facilityId, checklist: { exists: false } });

      const facility = await one<{ municipality_id: number | null }>(
        tx,
        sql`SELECT municipality_id FROM facilities WHERE id = ${facilityId}::uuid`,
      );
      const home = facility?.municipality_id;
      if (home === null || home === undefined) {
        throw new Error('fixture: the Sofia pin landed in no municipality (was the db seeded?)');
      }
      const elsewhere = await one<{ id: number }>(
        tx,
        sql`SELECT id FROM municipalities WHERE id <> ${home} ORDER BY id LIMIT 1`,
      );
      if (!elsewhere) throw new Error('fixture: need a second municipality (was the db seeded?)');

      const inScope = await makeUser(tx, 'amb-in', 'ambassador');
      const outOfScope = await makeUser(tx, 'amb-out', 'ambassador');
      const member = await makeUser(tx, 'member');
      const admin = await makeUser(tx, 'admin', 'admin');
      await tx.execute(sql`
        INSERT INTO ambassador_municipalities (user_id, municipality_id)
        VALUES (${inScope}, ${home}), (${outOfScope}, ${elsewhere.id})
      `);

      const photo = await one<{ id: string }>(
        tx,
        sql`SELECT id FROM facility_photos WHERE storage_path = ${keptPath}`,
      );
      const report = await one<{ id: string }>(
        tx,
        sql`SELECT id FROM facility_reports WHERE facility_id = ${facilityId}::uuid`,
      );
      const photoId = String(photo?.id);
      const refusedId = String(second?.id);
      const reportId = String(report?.id);
      // A refused photo loses its file, after the decision commits; nothing
      // else may touch storage.
      const files = recordingFiles();
      const state = () =>
        one(
          tx,
          sql`SELECT f.status, p.status AS photo, r.status AS report
                FROM facilities f
                JOIN facility_photos p ON p.facility_id = f.id AND p.id = ${photoId}::uuid
                JOIN facility_reports r ON r.facility_id = f.id
               WHERE f.id = ${facilityId}::uuid`,
        );

      // Out of scope, or no moderation role at all: zero rows, whatever the
      // application gate would have said.
      const asOutsider = { id: outOfScope, role: 'ambassador' } as const;
      const asMember = { id: member, role: 'user' } as const;
      expect(await decidePhoto(tx, asOutsider, photoId, 'approved', files)).toEqual({
        applied: false,
      });
      expect(await decidePhoto(tx, asOutsider, refusedId, 'rejected', files)).toEqual({
        applied: false,
      });
      expect(await decideFacility(tx, asOutsider, facilityId, 'gone')).toEqual({ applied: false });
      expect(await resolveReport(tx, asMember, reportId, 'dismissed')).toEqual({ applied: false });
      expect(await state()).toEqual({
        status: 'needs_verification',
        photo: 'pending',
        report: 'pending',
      });
      expect(files.deleted).toEqual([]);

      // In scope: applied, exactly once.
      const asAmbassador = { id: inScope, role: 'ambassador' } as const;
      expect(await decidePhoto(tx, asAmbassador, photoId, 'approved', files)).toEqual({
        applied: true,
      });
      expect(await decidePhoto(tx, asAmbassador, refusedId, 'rejected', files)).toEqual({
        applied: true,
      });
      expect(files.deleted).toEqual([refusedPath]);
      expect(await decideFacility(tx, asAmbassador, facilityId, 'verified')).toEqual({
        applied: true,
      });
      expect(await decideFacility(tx, asAmbassador, facilityId, 'gone')).toEqual({
        applied: false,
      });
      // An admin's scope is the country.
      expect(await resolveReport(tx, { id: admin, role: 'admin' }, reportId, 'dismissed')).toEqual({
        applied: true,
      });

      expect(await state()).toEqual({ status: 'active', photo: 'approved', report: 'dismissed' });

      // Every decision that landed is in the append-only log, with the scope
      // it was taken under; the refused ones left no trace.
      const log = await tx.execute(
        sql`SELECT actor_id, target_type, decision, municipality_id
              FROM moderation_decisions WHERE facility_id = ${facilityId}::uuid
             ORDER BY id`,
      );
      expect(log.rows).toEqual([
        { actor_id: inScope, target_type: 'photo', decision: 'approved', municipality_id: home },
        { actor_id: inScope, target_type: 'photo', decision: 'rejected', municipality_id: home },
        { actor_id: inScope, target_type: 'facility', decision: 'verified', municipality_id: home },
        { actor_id: admin, target_type: 'report', decision: 'dismissed', municipality_id: home },
      ]);
      // The field-level audit trail agrees with the log.
      expect(
        await one(
          tx,
          sql`SELECT actor, source, new_value FROM facility_edits
               WHERE facility_id = ${facilityId}::uuid AND field = 'status'`,
        ),
      ).toEqual({ actor: inScope, source: 'crowd', new_value: 'active' });
    });
  });
});
