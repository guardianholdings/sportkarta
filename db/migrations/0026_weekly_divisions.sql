-- Weekly divisions («дивизии») — docs/ENGAGEMENT.md B2, phase 9.
--
-- Groups of ~30 members of similar activity, Monday→Sunday civil Sofia weeks,
-- top promote / bottom relegate. It exists because one national ladder tells
-- almost every member the same thing forever ("you are #4,318"), and for a
-- platform whose subject is free public sport in a country where most adults do
-- none, that is the bottom of the board talking to nearly all of its members.
--
-- WHAT IS DELIBERATELY NOT STORED: score, rank, and the promote/hold/relegate
-- outcome. All three are recomputable — the score from `points_ledger` (append
-- only, so a closed week's total is stable), the rank by ordering it, and the
-- outcome from the tier difference between two consecutive weeks, because
-- `zoneFor` clamps at both ends of the ladder so difference and zone agree
-- exactly. `campaign_results` freezes a placing for the opposite reason: closing
-- is a one-time event whose inputs keep moving. A division's do not. A stored
-- rank here would be a second source of truth for a number every render
-- recomputes, and the two would eventually disagree.
--
-- CONSENT IS NOT IN THESE TABLES, and must never be moved into them.
-- db/src/divisions.ts joins `leaderboard_eligible_members` TWICE — when it
-- assigns and again when it displays. The second join is not redundant: a member
-- may publish their passport on Monday and unpublish it on Wednesday, and it is
-- what makes their name stop rendering. Ranks are computed AFTER that join, so
-- the ladder reads 1, 2, 3 with no gaps advertising the existence of hidden
-- competitors — the rule `publicStandings` already states in its own comment,
-- and operator decision 3 of 2026-07-26.
--
-- STRUCTURAL GUARANTEES, weakest to strongest:
--
--   division_groups_tier_range        five rungs, bounded in the database. An
--                                     out-of-range tier renders as a missing
--                                     i18n key on a public page. The five names
--                                     live in apps/web/messages/*.json under
--                                     `Division.tier.*`, keyed by the slugs in
--                                     `DIVISION_TIERS` (lib/src/divisions).
--   division_groups_week_is_monday    a week key is the Monday that starts it,
--                                     matching bucketKeyFor, the streaks and the
--                                     digest. NOTE the `isfinite` guard: since
--                                     PG14 `extract(isodow from 'infinity')` is
--                                     NULL and `NULL = 1` is NULL, which a CHECK
--                                     ACCEPTS. Same defect 0024 closed and 0025
--                                     was corrected for.
--   division_groups_id_week_unique    exists ONLY to be the target of the
--                                     composite FK below. Postgres will not
--                                     accept a PK as the target of a two-column
--                                     FK, so the pair must exist in its own
--                                     right. This does mean `division_groups`
--                                     carries a unique index whose leading
--                                     column duplicates the PK — a real prefix
--                                     redundancy, and an unavoidable one, since
--                                     neither index can be dropped. Recorded
--                                     here so the next reviewer does not
--                                     re-litigate it.
--   division_members_user_week_unique ONE GROUP PER MEMBER PER WEEK. The
--                                     assignment job is idempotent by
--                                     construction (planDivisions is
--                                     deterministic and the write is ON CONFLICT
--                                     DO NOTHING), but "the job is careful" is
--                                     not a constraint, and a member listed
--                                     twice appears on the ladder twice with two
--                                     different ranks.
--   division_members_group_week_fk    keeps the denormalised `week_start`
--                                     honest, and is the ONLY FK to the groups
--                                     table: a single-column one would be fully
--                                     implied by it and would cost a second RI
--                                     trigger pair on every insert plus a second
--                                     cascade pass on every group delete.
--                                     `week_start` is denormalised precisely so
--                                     the rule above can be a plain UNIQUE
--                                     rather than a trigger or an application
--                                     check — and an application check running
--                                     inside a job with retries is not a
--                                     guarantee. No separate isodow CHECK is
--                                     needed on this column: it can only hold a
--                                     value that already passed the group's.
--
-- division_members_week_group_idx IS THE LADDER'S READ PATH, not a nice-to-have.
-- `weekStandings` filters `dm.week_start = $1` and joins the group; Postgres
-- cannot infer the group's week from that join, so without a leading
-- `week_start` it scans every row this table has ever held — and it holds one
-- row per active member per week, forever, with no pruning. That is a public
-- page getting linearly slower every week it runs, on a single VPS. It is added
-- here, while the table is empty, because a later fix could not use CREATE INDEX
-- CONCURRENTLY: drizzle runs a migration inside one transaction and Postgres
-- rejects CONCURRENTLY there, so the late version would hold SHARE on
-- `division_members` and block the rollover for its duration.
--
-- ACCEPTED READ COST: `memberDivision` and `memberTier` probe
-- `(user_id, week_start)` and then need `group_id`, which that index does not
-- carry — one heap fetch each, for one row. `INCLUDE (group_id)` would close it
-- but drizzle cannot express INCLUDE, and hand-writing it would put the schema
-- and the migration out of step. Noted because 0025's header claims index-only
-- reads as a design property and this one does not inherit that claim.
--
-- RE-RUNNING A WEEK COMPLETES IT; IT DOES NOT REWRITE IT. Both writes are ON
-- CONFLICT DO NOTHING, so a run that died after writing three groups finishes
-- the other two on the next attempt — but an assignment already recorded is
-- never revised. Correcting a bad week therefore means deleting that week's rows
-- first (members, then groups) and re-running; the job will not self-heal a
-- wrong-but-complete ladder. Stated explicitly because "idempotent" is usually
-- read as "converges on the current plan", and here it means "does not
-- duplicate".
--
-- NO APPEND-ONLY TRIGGER, and that is a decision. Correcting a week requires
-- DELETE, so a table that refused it would make a bad ladder permanent. The trap
-- 0025's header describes applies anyway: a naive DELETE-refusing trigger fires
-- inside the `ON DELETE CASCADE` from `users` and aborts account erasure.
--
-- ERASURE: ON DELETE CASCADE from `users`, and deliberately NO
-- `account_deletions` counter — following `streak_freezes` (0025) and
-- `calendar_tokens` rather than `user_badges`. A membership is system-assigned,
-- regenerable placement, not a record of anything the member did; what they did
-- is their `points_ledger` rows, which are counted already. Adding a counter is
-- a four-place change (the column, the CHECK enumerating every counter,
-- `DeletionSummary`, the INSERT list) and would break the positional fixture in
-- apps/web/tests/account-deletion.test.ts. Both cascade paths are index-led:
-- `users` → members by `division_members_user_week_unique`, `division_groups` →
-- members by the PK's leading `group_id`.
--
-- NOT OPEN DATA. Neither table is on `ALLOWED_RELATIONS` in
-- lib/src/opendata/schema.ts, which matters because `division_members` holds a
-- `user_id`. Default-deny holds; do not add them.
--
-- JOURNAL NOTE: drizzle-kit stamped this from the real clock, which is BEHIND
-- 0025's hand-set 1785087600000 — the future-timestamp trap first hit at 0019.
-- Left alone, drizzle applies only past the newest recorded stamp, so this file
-- would have been silently skipped: exit 0, deploy green, tables absent. The
-- entry is hand-bumped to 1785091200000.
--
-- LOCK ORDER: the FK to `users` is added under a lock_timeout. A FOREIGN KEY
-- takes SHARE ROW EXCLUSIVE on the referenced table, so a deploy landing
-- mid-transaction would otherwise queue every write to `users` indefinitely —
-- sign-in included. Both tables are created empty in this same transaction, so
-- every lock here is held for microseconds and a contended `users` fails the
-- deploy in 3 s rather than stalling it.
--
-- rollback (compensating SQL; ONE explicit transaction, since `SET LOCAL`
-- outside a transaction block is a no-op with a WARNING):
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   DROP TABLE "division_members";
--   DROP TABLE "division_groups";
--   COMMIT;
-- Genuinely reversible: nothing references either table, no other table gained a
-- column, and the rollover job re-derives a week's assignments from
-- `points_ledger` on its next run. Drop the members table first — the composite
-- FK points at the groups table.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "division_groups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "division_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"week_start" date NOT NULL,
	"tier" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "division_groups_id_week_unique" UNIQUE("id","week_start"),
	CONSTRAINT "division_groups_tier_range" CHECK ("division_groups"."tier" BETWEEN 1 AND 5),
	CONSTRAINT "division_groups_ordinal_positive" CHECK ("division_groups"."ordinal" >= 1),
	CONSTRAINT "division_groups_week_is_monday" CHECK (isfinite("division_groups"."week_start") AND extract(isodow from "division_groups"."week_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "division_members" (
	"group_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"week_start" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "division_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "division_groups_week_tier_ordinal_unique" ON "division_groups" USING btree ("week_start","tier","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "division_members_user_week_unique" ON "division_members" USING btree ("user_id","week_start");--> statement-breakpoint
CREATE INDEX "division_members_week_group_idx" ON "division_members" USING btree ("week_start","group_id","user_id");--> statement-breakpoint
COMMENT ON TABLE "division_groups" IS 'One week''s division groups: a tier (1 = entry, 5 = top; the names live in apps/web/messages/*.json under Division.tier.*, keyed by the slugs in DIVISION_TIERS) and a group within it. week_start is the Monday that starts the civil Sofia week — the same key bucketKeyFor produces for streaks and the weekly digest, so the three can never disagree about when a week began.';--> statement-breakpoint
COMMENT ON TABLE "division_members" IS 'Who shared a division group in one week. MEMBERSHIP ONLY — no score, no rank, no outcome: all three are recomputable from points_ledger and the tier difference between consecutive weeks, and a stored copy would become a second source of truth for a number every render recomputes. Who may APPEAR is not decided here: db/src/divisions.ts joins leaderboard_eligible_members when assigning and again when displaying, and ranks are computed AFTER that join so the ladder reads 1,2,3 without gaps that would advertise the existence of hidden competitors.';--> statement-breakpoint
ALTER TABLE "division_members" ADD CONSTRAINT "division_members_group_week_fk" FOREIGN KEY ("group_id","week_start") REFERENCES "public"."division_groups"("id","week_start") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "division_members" ADD CONSTRAINT "division_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
