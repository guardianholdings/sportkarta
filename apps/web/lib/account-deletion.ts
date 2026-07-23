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
  /** facility_condition_reports rows whose reporter reference was cleared. */
  conditionReportsAnonymized: number;
  /** points_ledger rows removed with the account (points are personal data). */
  pointsErased: number;
  /** moderation_decisions rows left intact — accountability outlives the account. */
  moderationDecisionsPreserved: number;
  /** play_sessions this person organised, cancelled rather than deleted. */
  sessionsCancelled: number;
  /** play_session_rsvps removed with the account. */
  rsvpsErased: number;
  /** play_session_checkins removed with the account. */
  checkinsErased: number;
  /** digest_subscriptions removed with the account. */
  digestSubscriptionsErased: number;
  /** play_session_results whose participant reference was cleared. */
  resultsAnonymized: number;
  /** user_badges rows removed with the account. */
  badgesErased: number;
  /** campaign_results rows whose member reference was cleared. */
  campaignResultsAnonymized: number;
  /** play_session_notifications rows removed with the account. */
  sessionNotificationsErased: number;
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
    const conditionReportsAnonymized = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM facility_condition_reports WHERE reporter_id = ${userId}`,
      ),
    );
    // Points are personal data and leave with the account (unlike the audit
    // trail), so the tombstone has to be able to evidence that they did.
    const pointsErased = countFrom(
      await tx.execute(sql`SELECT count(*)::int AS n FROM points_ledger WHERE user_id = ${userId}`),
    );
    // Decisions stay (no FK, append-only): an erased ambassador's moderation
    // record must survive them, carrying only an id that no longer resolves.
    const moderationDecisionsPreserved = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM moderation_decisions WHERE actor_id = ${userId}`,
      ),
    );

    // Play layer (Stage 4.1). RSVPs and check-ins are the person's OWN data and
    // leave with the account through the cascade, so they are counted like
    // points. Sessions they organised are a different case: other people's past
    // attendance is not the organiser's data to destroy, so organizer_id is
    // ON DELETE SET NULL and the play_sessions_orphan_cancel trigger cancels the
    // series — future occurrences with it. Nothing is done here to make that
    // happen; the count is taken so the tombstone can evidence that it did.
    const rsvpsErased = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM play_session_rsvps WHERE user_id = ${userId}`,
      ),
    );
    const checkinsErased = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM play_session_checkins WHERE user_id = ${userId}`,
      ),
    );
    const sessionsCancelled = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM play_sessions
             WHERE organizer_id = ${userId} AND status = 'scheduled'`,
      ),
    );

    // Digest opt-ins are consent and leave with the account (Stage 4.4).
    // Results do NOT: a result is a fact about a game other people played in
    // too, so the row stays with the participant reference cleared (Stage 4.6),
    // which is why one counter says "erased" and the other "anonymized".
    const digestSubscriptionsErased = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM digest_subscriptions WHERE user_id = ${userId}`,
      ),
    );
    const resultsAnonymized = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM play_session_results WHERE participant_user_id = ${userId}`,
      ),
    );
    // Badges are the member's own record and hold nobody else's data, so they
    // leave with the account (Stage 5.1). They were only ever a notification
    // cache in any case: the badges themselves are derived from points_ledger,
    // which is erased in this same transaction.
    const badgesErased = countFrom(
      await tx.execute(sql`SELECT count(*)::int AS n FROM user_badges WHERE user_id = ${userId}`),
    );
    // A frozen campaign placing is a fact about a competition other people
    // entered, so the row STAYS with its member reference cleared (Stage 5.3) —
    // the rank and score survive, the person does not. Hence "anonymized"
    // rather than "erased", like play_session_results.
    const campaignResultsAnonymized = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM campaign_results WHERE user_id = ${userId}`,
      ),
    );

    // "We emailed this person about this session on this evening" (Stage 4.2)
    // is the member's own data and nobody else's, so it leaves with the account
    // — a tombstone that kept it would be a small archive of their week. The
    // calendar token goes the same way through the cascade, uncounted: it is
    // one credential row, not a record of anything the member did.
    const sessionNotificationsErased = countFrom(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM play_session_notifications WHERE user_id = ${userId}`,
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
      INSERT INTO account_deletions (
        user_id, audit_rows_preserved, photos_anonymized,
        condition_reports_anonymized, points_erased, moderation_decisions_preserved,
        sessions_cancelled, rsvps_erased, checkins_erased,
        digest_subscriptions_erased, results_anonymized, badges_erased,
        campaign_results_anonymized, session_notifications_erased
      )
      VALUES (${userId}, ${auditRowsPreserved}, ${photosAnonymized},
              ${conditionReportsAnonymized}, ${pointsErased}, ${moderationDecisionsPreserved},
              ${sessionsCancelled}, ${rsvpsErased}, ${checkinsErased},
              ${digestSubscriptionsErased}, ${resultsAnonymized}, ${badgesErased},
              ${campaignResultsAnonymized}, ${sessionNotificationsErased})
    `);

    // Cascades to sessions, accounts, the points ledger, user_badges, the
    // session-notification ledger and the calendar token; nulls
    // facility_photos.uploaded_by and facility_condition_reports.reporter_id.
    await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`);

    return {
      userId,
      auditRowsPreserved,
      photosAnonymized,
      conditionReportsAnonymized,
      pointsErased,
      moderationDecisionsPreserved,
      sessionsCancelled,
      rsvpsErased,
      checkinsErased,
      digestSubscriptionsErased,
      resultsAnonymized,
      badgesErased,
      campaignResultsAnonymized,
      sessionNotificationsErased,
    };
  });
}
