import { sql, type SQL } from '@sportkarta/db';

/**
 * GDPR/ЗЗЛД self-service erasure (docs/ROADMAP.md §5).
 *
 * Three things must all hold at once:
 *
 *  1. The profile is really gone — the users row is deleted, taking sessions,
 *     OAuth accounts and pending one-time codes with it. No soft delete, no
 *     "deleted" flag that keeps the person's name in the table.
 *  2. Contributions are anonymised — facility_photos.uploaded_by is cleared by
 *     the foreign key (ON DELETE SET NULL), and every remaining reference to
 *     the account resolves to the "former user" label at display time, because
 *     nothing is left to resolve it to.
 *  3. The audit trail survives — facility_edits is append-only (triggers from
 *     migration 0001) and is NOT touched here. Its rows keep the opaque actor
 *     id; what is destroyed is the mapping from that id to a person. Rewriting
 *     or deleting audit rows would forge the record of who changed what, which
 *     is exactly what an audit log exists to prevent.
 *
 * A tombstone row (no personal data) records that the erasure happened and how
 * many audit rows it deliberately left alone.
 */

export interface DeletionSummary {
  userId: string;
  /** facility_edits rows left intact — the audit trail. */
  auditRowsPreserved: number;
  /** facility_photos rows whose uploader reference was cleared. */
  photosAnonymized: number;
}

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function countFrom(result: { rows: Record<string, unknown>[] }): number {
  const value = result.rows[0]?.n;
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export async function deleteAccount(db: TransactionalDb, userId: string): Promise<DeletionSummary> {
  return db.transaction(async (tx) => {
    const auditRowsPreserved = countFrom(
      await tx.execute(sql`SELECT count(*)::int AS n FROM facility_edits WHERE actor = ${userId}`),
    );
    const photosAnonymized = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM facility_photos WHERE uploaded_by = ${userId}`,
      ),
    );

    // Pending one-time codes are keyed by email address, not by user id, so the
    // cascade does not reach them. Left behind they would be a short-lived
    // record of the address that asked to be forgotten.
    // better-auth keys OTP records as "<type>-otp-<email>"; the suffix match is
    // exact (no LIKE wildcards to escape) and covers every OTP type.
    await tx.execute(sql`
      DELETE FROM verifications v
      USING users u
      WHERE u.id = ${userId}
        AND (
          v.identifier = u.email
          OR right(v.identifier, char_length(u.email) + 5) = '-otp-' || u.email
        )
    `);

    await tx.execute(sql`
      INSERT INTO account_deletions (user_id, audit_rows_preserved, photos_anonymized)
      VALUES (${userId}, ${auditRowsPreserved}, ${photosAnonymized})
    `);

    // Cascades to sessions and accounts; nulls facility_photos.uploaded_by.
    await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`);

    return { userId, auditRowsPreserved, photosAnonymized };
  });
}
