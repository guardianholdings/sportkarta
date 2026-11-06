-- 0062_club_payment_failures: «Клубове» — what the books say when Stripe
-- says no (payments-readiness review 2026-10-31, findings 2 and 4).
-- Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
-- One audit action (club_audit.action):
--
--   online_payment_failed   Stripe could not collect a renewal invoice for a
--                           member's subscription (invoice.payment_failed).
--                           Until now the worker did not handle the event at
--                           all: the period silently never arrived, and
--                           nobody — not the club, not the member — was told.
--                           The row names the membership and the invoice (ids),
--                           once per invoice, and the worker mails both sides.
--
-- Two notice kinds (club_notifications.kind):
--
--   club_payments_revoked    the club revoked POPS's access from its own
--                            Stripe dashboard (account.application.deauthorized).
--                            The worker now also closes that account's open
--                            checkouts, stops the renewal of every chain opened
--                            on it (the books can no longer hear about them),
--                            writes the club's audit row (as the existing
--                            payment_account_disconnected, by 'system') and
--                            tells each owner how many subscriptions they must
--                            now end or manage in Stripe themselves.
--   renewal_payment_failed   the failed renewal above, to the member and to
--                            the owners — one notice per invoice.
--
-- One partial index, club_audit_provider_disconnect_idx, on exactly the rows
-- the revoke writes (action = 'payment_account_disconnected' by 'system'),
-- by acted_at. Two readers: «Здраве» (apps/web/lib/ops-health.ts) sums their
-- subscription counts over the last 30 days, and the worker's retry of a
-- revoke event finds the row that event wrote (db/src/clubs/payments.ts,
-- markPaymentAccountGone, by detail->>'eventId'). Without it both scan the
-- whole log.
--
-- No column changes: a failed renewal is a FACT about the chain, recorded in
-- the append-only audit log and keyed by the invoice; the chain's own state
-- (renews, renewal_ends_on) stays what the office and the member set.
--
-- Locking: each CHECK swap takes ACCESS EXCLUSIVE on its table until COMMIT
-- (DROP CONSTRAINT holds it; NOT VALID + VALIDATE is the repo's pattern) and
-- scans it once. The index is built in the same transaction (CONCURRENTLY
-- cannot run inside one) under the lock already held, one more scan. Both
-- tables are small in any club's first year; the scans are milliseconds.
--
-- rollback: the new values are only ever written by the WORKER (the
-- invoice.payment_failed and account.application.deauthorized handlers in
-- apps/worker/src/club-payments-job.ts), so revert the worker first — with
-- the CHECKs narrowed under a worker that still writes them, each such Stripe
-- event would fail its INSERT, roll back its whole transaction (the closed
-- checkouts and stopped renewals of a revoked account included) and be
-- retried by Stripe for three days.
-- The widened club_audit_action_known then STAYS, as after every earlier
-- widening (0045 through 0057): club_audit is append-only —
-- club_audit_no_delete (0039) refuses the DELETE that narrowing would need —
-- and a superset is harmless to the reverted application.
-- The index may go at any time: DROP INDEX "club_audit_provider_disconnect_idx";
-- («Здраве» and the worker's revoke retry then scan the log; nothing breaks.)
-- club_notifications may be narrowed, in ONE transaction: delete the rows of
-- the two kinds (losing their dedupe state — the worker would not re-send
-- them, since their events are already processed), re-create the constraint
-- with 0061's list and restore its comment:
--   DELETE FROM "club_notifications"
--    WHERE "kind" IN ('club_payments_revoked', 'renewal_payment_failed');
--   ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";
--   ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known"
--     CHECK (kind IN (<the 0061 list, lines 81–93>));
--   COMMENT ON CONSTRAINT "club_notifications_kind_known" ON "club_notifications"
--     IS <0061's comment, lines 95–96>;
-- A corrective migration needs a journal `when` above 1785220800000.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "club_audit" DROP CONSTRAINT "club_audit_action_known";--> statement-breakpoint
ALTER TABLE "club_audit" ADD CONSTRAINT "club_audit_action_known" CHECK ("club_audit"."action" IN (
	    'club_applied', 'settings_changed', 'location_saved', 'location_archived', 'kiosk_created',
	    'kiosk_paired', 'kiosk_revoked', 'staff_invited', 'staff_invite_revoked', 'staff_joined',
	    'staff_role_changed', 'staff_removed', 'member_created', 'member_updated', 'member_archived',
	    'member_restored', 'member_erased', 'link_invited', 'link_claimed', 'link_approved',
	    'link_declined', 'link_removed', 'erasure_requested', 'owner_erased', 'plan_saved',
	    'plan_archived', 'membership_sold', 'membership_paused', 'membership_resumed', 'membership_cancelled',
	    'charge_created', 'charge_voided', 'payment_recorded', 'refund_recorded', 'class_saved',
	    'class_cancelled', 'occurrence_cancelled', 'booking_created', 'booking_cancelled', 'checkin_recorded',
	    'import_committed', 'export_downloaded', 'ngo_admin_viewed', 'membership_renewed', 'renewal_stopped',
	    'fee_charged', 'time_off_saved', 'time_off_removed', 'faq_saved', 'faq_removed',
	    'staff_profile_changed', 'preferences_changed', 'payment_account_connected', 'payment_account_disconnected', 'checkout_started',
	    'online_payment_received', 'online_refund_issued', 'resource_saved', 'resource_archived', 'hours_saved',
	    'service_saved', 'service_archived', 'reservation_created', 'reservation_cancelled', 'product_saved',
	    'product_archived', 'stock_moved', 'sale_recorded', 'sale_reversed', 'promotion_saved',
	    'promotion_archived', 'wallet_topped_up', 'invoice_issued', 'credit_note_issued', 'broadcast_saved',
	    'broadcast_scheduled', 'broadcast_cancelled', 'automation_saved', 'sms_settings_changed', 'thread_started',
	    'thread_closed', 'thread_reopened', 'inquiry_received', 'lead_opened', 'lead_updated',
	    'lead_lost', 'lead_reopened', 'feedback_settings_changed', 'event_saved', 'event_published',
	    'event_cancelled', 'event_registered', 'event_registration_cancelled', 'tournament_drawn', 'match_recorded',
	    'name_visibility_changed', 'document_saved', 'document_versioned', 'document_archived', 'document_restored',
	    'document_signed', 'ladder_saved', 'ladder_archived', 'ladder_restored', 'rank_saved',
	    'rank_moved', 'rank_removed', 'rank_awarded', 'rank_revoked', 'api_key_created',
	    'api_key_revoked', 'webhook_saved', 'webhook_disabled', 'webhook_enabled', 'webhook_removed',
	    'webhook_secret_rotated', 'door_device_created', 'door_device_revoked', 'online_payment_failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON CONSTRAINT "club_audit_action_known" ON "club_audit" IS
  'The closed list of club audit actions; the TypeScript twin is CLUB_AUDIT_ACTIONS in lib/src/clubs/vocab.ts (0062 added the failed online renewal).';--> statement-breakpoint
ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known" CHECK ("club_notifications"."kind" IN (
	    'member_invite', 'staff_invite', 'booking_confirmed', 'booking_promoted', 'booking_cancelled',
	    'class_cancelled', 'reminder_24h', 'membership_expiring', 'membership_expired', 'application_received',
	    'application_approved', 'operator_new_application', 'claim_pending', 'erasure_requested', 'roster_daily',
	    'owner_weekly', 'membership_renewed', 'fee_charged', 'owner_monthly', 'payment_received',
	    'broadcast', 'automation', 'inbox_message', 'inbox_reply', 'leads_due',
	    'event_registered', 'event_promoted', 'event_cancelled', 'application_rejected', 'club_trial_ending',
	    'club_past_due', 'club_lapsed', 'club_suspended', 'club_contract_renewing', 'club_payments_revoked',
	    'renewal_payment_failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
COMMENT ON CONSTRAINT "club_notifications_kind_known" ON "club_notifications" IS
  'The closed list of notices; the TypeScript twin is CLUB_NOTIFICATION_KINDS in lib/src/clubs/vocab.ts (0062 added the revoked Stripe connection and the failed renewal).';--> statement-breakpoint
CREATE INDEX "club_audit_provider_disconnect_idx" ON "club_audit" USING btree ("acted_at") WHERE "club_audit"."action" = 'payment_account_disconnected' AND "club_audit"."actor_kind" = 'system';--> statement-breakpoint
COMMENT ON INDEX "club_audit_provider_disconnect_idx" IS
  'The revokes a club made in its own Stripe dashboard (0062): «Здраве» sums their subscriptionsAtStripe over 30 days (apps/web/lib/ops-health.ts); the worker''s retry of a revoke event finds its own row by detail->>''eventId'' (db/src/clubs/payments.ts).';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
