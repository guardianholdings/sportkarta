-- Streak freezes («замразяване») — docs/ENGAGEMENT.md A4, phase 4.
--
-- A row is a week the member MISSED that does not break their streak. The fold
-- in lib/src/badges/streaks.ts stays pure and takes the set of frozen keys as a
-- parameter, so the DST suite still pins real transitions with no database in
-- sight; this table is the only state the mechanic has.
--
-- NOT A BALANCE. CLAUDE.md fixes the points economy as earning-only with no
-- spending mechanics, and a freeze the member holds and spends would be exactly
-- that mechanic. This is forgiveness the SYSTEM applies, capped per rolling
-- year by the granting job. Nothing is bought, held or consumed, and the
-- member-facing copy must say "applied", never "used up".
--
-- WHY THE CAP IS NOT A CONSTRAINT. "At most N rows per member per rolling 12
-- months" is a COUNT over a moving window; no CHECK, UNIQUE or EXCLUDE can
-- express it. It is enforced in the granting job, the same way
-- ATTENDANCE_AWARDS_PER_DAY is enforced in apps/web/lib/sessions/checkin.ts
-- rather than in DDL. What IS structural is everything that can be:
--
--   streak_freezes_week_only        weeks only — a day-streak freeze would be
--                                   the daily loss-pressure loop ENGAGEMENT.md
--                                   §3 rejects (Octalysis Core Drive 8, with
--                                   minors named in the EU Digital Fairness
--                                   Act). A caller cannot widen the mechanic to
--                                   days by passing a different string.
--   streak_freezes_bucket_is_monday a week key is the Monday that starts it,
--                                   matching bucketKeyFor and the digest's
--                                   week. NOTE the `isfinite` guard: since PG14
--                                   `extract(isodow from 'infinity'::date)` is
--                                   NULL, and `NULL = 1` is NULL, which a CHECK
--                                   ACCEPTS — an infinite key would then match
--                                   no key the fold looks up (the freeze
--                                   silently does nothing) while still
--                                   consuming one of the year's allowance. Same
--                                   defect 0024 was written to close.
--   ..._user_unit_bucket_unique     one freeze per member per week: the fold
--                                   reads a SET, and a duplicate would let a
--                                   retry of the granting job quietly consume
--                                   two of the year's allowance. Also the read
--                                   path — `bucket_key` is in the index, so
--                                   "which weeks are frozen for this member" is
--                                   index-only. A separate (user_id) index
--                                   would be a redundant prefix AND force a
--                                   heap fetch, so there deliberately is none.
--
-- NO APPEND-ONLY TRIGGER, and that is a decision rather than an omission. A
-- naive DELETE-refusing trigger fires INSIDE the `ON DELETE CASCADE` from
-- `users` and aborts the delete, so account erasure could never complete — the
-- trap 0006 was written around. If one is ever wanted, copy
-- `forbid_points_ledger_mutation()`'s DELETE escape hatch and pinned
-- `search_path` verbatim; do not write a fresh one.
--
-- ERASURE: ON DELETE CASCADE, and deliberately NO account_deletions counter,
-- following `calendar_tokens` — the schema's ONLY uncounted user-scoped cascade
-- ("one credential row, not a record of anything the member did",
-- apps/web/lib/account-deletion.ts). The same reading applies: a freeze is
-- system-applied, regenerable state. `user_badges` DOES carry a counter
-- (`badges_erased`, 0010) — it is not precedent for omitting one. Adding a
-- counter is a four-place change (column, the CHECK enumerating every counter,
-- DeletionSummary, the INSERT list) and would break the positional fixture in
-- apps/web/tests/account-deletion.test.ts.
--
-- JOURNAL NOTE: drizzle-kit stamps this from the real clock, which is BEHIND
-- 0024's hand-set 1785084000000 — the future-timestamp trap first hit at 0019.
-- Left alone, drizzle applies only past the newest recorded stamp, so this file
-- would have been silently skipped: exit 0, deploy green, table absent. The
-- entry is hand-bumped to 1785087600000.
--
-- rollback (compensating SQL; ONE explicit transaction, since `SET LOCAL`
-- outside a transaction block is a no-op with a WARNING):
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   DROP TABLE "streak_freezes";
--   COMMIT;
-- Genuinely reversible: nothing references it, the fold degrades to "no weeks
-- frozen", and the granting job re-applies within the cap on its next run.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "streak_freezes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "streak_freezes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"unit" text DEFAULT 'week' NOT NULL,
	"bucket_key" date NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "streak_freezes_week_only" CHECK ("streak_freezes"."unit" = 'week'),
	CONSTRAINT "streak_freezes_bucket_is_monday" CHECK (isfinite("streak_freezes"."bucket_key") AND extract(isodow from "streak_freezes"."bucket_key") = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "streak_freezes_user_unit_bucket_unique" ON "streak_freezes" USING btree ("user_id","unit","bucket_key");
--> statement-breakpoint
COMMENT ON TABLE "streak_freezes" IS 'Weeks a member MISSED that do not break their streak. NOT a balance: CLAUDE.md fixes the points economy as earning-only with no spending mechanics, so this is forgiveness the SYSTEM applies on the member''s behalf, capped per rolling year by the granting job. Member-facing copy must say APPLIED, never spent or used up. Weeks only, by CHECK — a day-streak freeze would be the daily loss-pressure loop the engagement plan rejects.';--> statement-breakpoint
ALTER TABLE "streak_freezes" ADD CONSTRAINT "streak_freezes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
