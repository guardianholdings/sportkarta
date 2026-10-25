-- 0038_club_enum_values: the enum values the «Клубове» add-on needs, and
-- NOTHING else (docs/ROADMAP.md Stage 9, docs/MONETISATION.md S7).
--
-- WHY A FILE OF ITS OWN. drizzle's migrator runs every pending file in ONE
-- transaction, on production as on a fresh database (CI's e2e job, db:reset).
-- PostgreSQL 12+ accepts `ALTER TYPE ... ADD VALUE` inside a transaction, but a
-- value added there cannot be USED until the transaction commits: casting the
-- text 'club' to `training_source` in the same batch fails with "unsafe use of
-- new value". So:
--   * the values are added first, here, and
--   * every later statement in 0039–0044 that names one of them compares the
--     column AS TEXT (`source::text = 'club'`, `action::text IN (...)`), which
--     never casts to the enum and therefore works in the same transaction.
-- That keeps all seven club migrations shippable in one deploy instead of two.
--
-- THE VALUES:
--   admin_action      club_created, club_updated, club_status_changed,
--                     club_plan_changed, club_staff_granted, club_staff_revoked,
--                     club_purged — the operator's changes from /admin/klubove,
--                     recorded in the append-only admin_actions log (0033).
--   training_source   club — a training-log row written by a club check-in.
--   training_evidence qr_verified — the third evidence tier. 0027 drafted it and
--                     removed it "because nothing could grant it". A QR or card
--                     check-in at a club desk, by a member who linked their POPS
--                     account and consented, is what now grants it (0043 rewrites
--                     the CHECK that pins evidence to source).
--
-- Postgres has no DROP VALUE (0014's header), so these are permanent. Each one
-- is used by 0039–0044 and by apps/web/lib/clubs; none is speculative.
--
-- Locking: ADD VALUE takes a lock on the type's catalogue row only; no table is
-- rewritten or scanned. IF NOT EXISTS makes a re-run harmless.
--
-- rollback: none possible for an enum value (no DROP VALUE). The values are
-- inert until 0039–0044 and the application use them; an application rollback
-- leaves them unused, which is harmless.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TYPE "public"."admin_action" ADD VALUE IF NOT EXISTS 'club_created';--> statement-breakpoint
ALTER TYPE "public"."admin_action" ADD VALUE IF NOT EXISTS 'club_updated';--> statement-breakpoint
ALTER TYPE "public"."admin_action" ADD VALUE IF NOT EXISTS 'club_status_changed';--> statement-breakpoint
ALTER TYPE "public"."admin_action" ADD VALUE IF NOT EXISTS 'club_plan_changed';--> statement-breakpoint
ALTER TYPE "public"."admin_action" ADD VALUE IF NOT EXISTS 'club_staff_granted';--> statement-breakpoint
ALTER TYPE "public"."admin_action" ADD VALUE IF NOT EXISTS 'club_staff_revoked';--> statement-breakpoint
ALTER TYPE "public"."admin_action" ADD VALUE IF NOT EXISTS 'club_purged';--> statement-breakpoint
ALTER TYPE "public"."training_source" ADD VALUE IF NOT EXISTS 'club';--> statement-breakpoint
ALTER TYPE "public"."training_evidence" ADD VALUE IF NOT EXISTS 'qr_verified';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
