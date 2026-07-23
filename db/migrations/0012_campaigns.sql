-- 0012_campaigns: the campaign engine (docs/ROADMAP.md §7, Stage 5.3). Two new
-- tables, four enums, one counter on the GDPR tombstone. No existing row is
-- rewritten and no data is destroyed.
--
-- WHY THIS ONE HAS TABLES WHEN 0010 DELIBERATELY HAD NONE. Badges (5.1) are
-- config in the strict sense — a TypeScript array, developer-authored — and
-- giving the database an opinion about which badges exist would have made every
-- new badge a migration. A campaign is different in kind: an admin creates one
-- from a browser on a Tuesday, without a deploy. That is a row.
--
-- What stays config is `campaigns.rules`, a JSONB document validated against the
-- closed grammar in lib/src/campaigns/rules.ts and compiled to ONE SQL aggregate
-- in db/src/campaigns.ts. The line is: creating a campaign is a form; inventing
-- a new KIND of scoring is a grammar change, with a deploy and a test. DO NOT
-- turn `rules` into columns — that puts every campaign idea back into a
-- migration — and do not put an expression language in it either, which would
-- hand whoever can edit a campaign arbitrary logic over the ledger.
--
-- campaigns_rules_shaped IS WRITTEN WITH CASE, NOT AND, AND THAT IS LOAD
-- BEARING. For an object with no `events` key, `rules -> 'events'` is SQL NULL;
-- jsonb_typeof and jsonb_array_length are strict; so `TRUE AND NULL AND NULL`
-- evaluates to NULL — and a CHECK is SATISFIED when its expression is NULL. The
-- obvious conjunction therefore ACCEPTS an empty object and a misspelled key,
-- which is precisely the unreadable campaign this constraint exists to prevent,
-- and the JSONB column has no other defence once the application is bypassed
-- (psql, a future import, an admin API regression). CASE additionally stops
-- jsonb_array_length raising on a non-array, and does not depend on AND's
-- evaluation order, which Postgres does not guarantee. The array is bounded
-- above as well as below: there are four event kinds, so anything past a
-- handful is a generator bug rather than a campaign.
--
-- THE WINDOW IS CIVIL. starts_on/ends_on are `date`, expanded to instants in
-- Europe/Sofia at query time, exactly like play_sessions' wall-clock scheduling
-- (0008) and the digest week (0009). A campaign "ending 31 August" ends at
-- midnight in Sofia — 21:00Z in summer, 22:00Z in winter — and storing a UTC
-- instant would end some campaigns three hours early. ends_on is INCLUSIVE as
-- authored and exclusive as compiled; that off-by-one silently discards the
-- last day of every campaign, which is the busiest one because people rush.
-- campaigns_window_bounded permits starts_on … starts_on + 365, i.e. a 366-day
-- INCLUSIVE span — one leap year — which is not what "+ 366" reads like.
--
-- campaigns_scope_coherent puts scope validity in the database rather than in a
-- form: a quarter campaign with no municipality would compile to a predicate
-- matching every quarter of that name in the country, and "Център" is a quarter
-- in most Bulgarian towns. It ENUMERATES all three scope kinds rather than
-- excluding bad ones, so a future ALTER TYPE ... ADD VALUE is forbidden until
-- somebody deliberately permits it (0010's lesson). campaigns_closed_pair fails
-- closed the same way: a new terminal status such as 'archived' would be forced
-- to keep closed_at NULL until this constraint is revisited.
--
-- WHY campaign_results EXISTS AT ALL. A results page that recomputes live
-- changes after prizes are announced — a late moderation reversal, an erasure,
-- a corrected ledger row — and a winner who changes after the fact is the worst
-- failure this feature can have. Closing a campaign FREEZES rank and score into
-- this table, and the public results page reads it rather than re-running the
-- query.
--
-- WHAT IS NOT FROZEN IS THE IDENTITY, AND THAT IS THE WHOLE GDPR DESIGN. There
-- is no display_name column here. The row holds the opaque user id and the
-- numbers; the name is resolved at render time through
-- leaderboard_eligible_members (0011). So the FACT — who placed where — outlives
-- everything, while the PERSONAL DATA does not outlive the account or the
-- consent: an erased member renders as the "former user" label and one who has
-- since made their passport private renders anonymously, both keeping their
-- placing. Freezing the name instead would be retaining personal data in a
-- table erasure cannot reach.
--
-- campaign_results_one_subject ALLOWS BOTH COLUMNS NULL, and that is the 0009
-- lesson applied rather than an oversight. user_id is ON DELETE SET NULL, which
-- Postgres performs as an UPDATE that re-validates every CHECK on the row. A
-- constraint demanding "exactly one subject" would therefore abort
-- DELETE FROM users permanently, with no retry that could ever succeed. A
-- both-NULL row is precisely an erased member's placing. THAT READING DEPENDS
-- ON municipality_id STAYING RESTRICT: relax it to SET NULL and a city row that
-- loses its municipality also becomes both-NULL, passes this check, and renders
-- as an anonymous former member.
--
-- The two uniqueness guards are PARTIAL for the same family of reason. A plain
-- UNIQUE with NULLS NOT DISTINCT would abort DELETE FROM users the second time
-- a member of the same campaign is erased, since both rows would then collide
-- on (campaign_id, NULL) — the 0009 trap arriving by a new route. They exist
-- because "written once at close" is otherwise enforced only in application
-- code, which leaves a re-opened-then-re-closed campaign free to stack a second
-- set of standings on the first.
--
-- municipality_id is RESTRICT on both tables, matching facilities.municipality_id
-- (0001) and moderation_decisions.municipality_id (0007): a frozen result must
-- never dangle, and a snapshot that can no longer name the city it ranked is not
-- a record of anything. Both municipality FKs are INDEXED, because RESTRICT
-- means every delete or key-update on municipalities checks them, and an
-- unindexed FK seq-scans the referencing table under lock.
--
-- campaign_results.campaign_id is CASCADE. That is right for discarding a draft
-- and is ALSO the sanctioned way to destroy published results: a single
-- DELETE FROM campaigns on a CLOSED campaign removes its frozen standings with
-- no further guard and no audit row. Delete drafts freely; deleting a closed
-- campaign is a restore-from-backup-or-nothing operation.
--
-- LOCKING, STATED CORRECTLY. campaigns and campaign_results are new, so nothing
-- waits on them — BUT the three FOREIGN KEY constraints referencing `users` and
-- `municipalities` take SHARE ROW EXCLUSIVE on those tables, which blocks every
-- WRITE to them (better-auth's sign-in upserts, profile saves, GDPR erasure)
-- until COMMIT, because drizzle runs the file as one transaction. They are
-- therefore placed at the very END of this file, as 0009 does for the same
-- reason, keeping that window to the last milliseconds. lock_timeout bounds the
-- wait to acquire the lock; statement_timeout bounds the hold. The reordering
-- is deadlock-safe: this file and apps/web/lib/account-deletion.ts both touch
-- account_deletions before users, in that order, so they serialise.
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE where noted).
-- PRECONDITION: roll the APPLICATION back first — dropping these tables while
-- the current build is deployed makes every /kampanii route 500.
--   DROP TABLE "campaign_results";                                  -- DESTRUCTIVE:
--       destroys every FROZEN final standing. These cannot be recomputed — that
--       is the entire reason they exist, since the live query now returns
--       different numbers than it did at close. If a campaign's results have
--       been published or a prize awarded on them, RESTORE FROM THE NIGHTLY
--       BACKUP rather than re-closing the campaign, which would silently mint a
--       different winner.
--   DROP TABLE "campaigns";                                         -- DESTRUCTIVE:
--       destroys admin-authored content (titles, blurbs, prize text) and every
--       campaign definition. Not recoverable from anything else.
--   DROP TYPE "campaign_template"; DROP TYPE "campaign_leaderboard_type";
--   DROP TYPE "campaign_scope_kind"; DROP TYPE "campaign_status";
--   ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";
--   ALTER TABLE "account_deletions" DROP COLUMN "campaign_results_anonymized"; -- DESTRUCTIVE:
--       erasure receipts recorded since this migration lose their campaign count.
--   ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
--             AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
--             AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
--             AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
--             AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0
--             AND "account_deletions"."badges_erased" >= 0);
SET lock_timeout = '3s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TYPE "public"."campaign_leaderboard_type" AS ENUM('individual', 'city');--> statement-breakpoint
CREATE TYPE "public"."campaign_scope_kind" AS ENUM('national', 'city', 'quarter');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'published', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."campaign_template" AS ENUM('standard', 'sprint', 'city_race');--> statement-breakpoint
CREATE TABLE "campaign_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaign_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"campaign_id" uuid NOT NULL,
	"user_id" text,
	"municipality_id" integer,
	"rank" integer NOT NULL,
	"score" integer NOT NULL,
	"member_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_results_rank_positive" CHECK ("campaign_results"."rank" >= 1),
	CONSTRAINT "campaign_results_score_non_negative" CHECK ("campaign_results"."score" >= 0),
	CONSTRAINT "campaign_results_member_count_positive" CHECK ("campaign_results"."member_count" >= 1),
	CONSTRAINT "campaign_results_one_subject" CHECK (("campaign_results"."user_id" IS NOT NULL AND "campaign_results"."municipality_id" IS NULL)
          OR ("campaign_results"."user_id" IS NULL AND "campaign_results"."municipality_id" IS NOT NULL)
          OR ("campaign_results"."user_id" IS NULL AND "campaign_results"."municipality_id" IS NULL))
);--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"scope_kind" "campaign_scope_kind" DEFAULT 'national' NOT NULL,
	"municipality_id" integer,
	"quarter" text,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"leaderboard_type" "campaign_leaderboard_type" DEFAULT 'individual' NOT NULL,
	"template" "campaign_template" DEFAULT 'standard' NOT NULL,
	"rules" jsonb NOT NULL,
	"title_bg" text NOT NULL,
	"title_en" text,
	"blurb_bg" text,
	"blurb_en" text,
	"prize_bg" text,
	"prize_en" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_slug_unique" UNIQUE("slug"),
	CONSTRAINT "campaigns_scope_coherent" CHECK (("campaigns"."scope_kind" = 'national' AND "campaigns"."municipality_id" IS NULL AND "campaigns"."quarter" IS NULL)
          OR ("campaigns"."scope_kind" = 'city' AND "campaigns"."municipality_id" IS NOT NULL AND "campaigns"."quarter" IS NULL)
          OR ("campaigns"."scope_kind" = 'quarter' AND "campaigns"."municipality_id" IS NOT NULL AND "campaigns"."quarter" IS NOT NULL)),
	CONSTRAINT "campaigns_window_order" CHECK ("campaigns"."ends_on" >= "campaigns"."starts_on"),
	CONSTRAINT "campaigns_window_bounded" CHECK ("campaigns"."ends_on" < "campaigns"."starts_on" + 366),
	CONSTRAINT "campaigns_slug_shape" CHECK ("campaigns"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("campaigns"."slug") <= 60),
	CONSTRAINT "campaigns_title_sane" CHECK (btrim("campaigns"."title_bg") <> '' AND char_length("campaigns"."title_bg") <= 120
          AND ("campaigns"."title_en" IS NULL OR char_length("campaigns"."title_en") <= 120)),
	CONSTRAINT "campaigns_body_sane" CHECK (("campaigns"."blurb_bg" IS NULL OR char_length("campaigns"."blurb_bg") <= 2000)
          AND ("campaigns"."blurb_en" IS NULL OR char_length("campaigns"."blurb_en") <= 2000)
          AND ("campaigns"."prize_bg" IS NULL OR char_length("campaigns"."prize_bg") <= 2000)
          AND ("campaigns"."prize_en" IS NULL OR char_length("campaigns"."prize_en") <= 2000)),
	CONSTRAINT "campaigns_quarter_sane" CHECK ("campaigns"."quarter" IS NULL OR (btrim("campaigns"."quarter") <> '' AND char_length("campaigns"."quarter") <= 120)),
	CONSTRAINT "campaigns_rules_shaped" CHECK (jsonb_typeof("campaigns"."rules") = 'object'
          AND CASE WHEN jsonb_typeof("campaigns"."rules" -> 'events') = 'array'
                   THEN jsonb_array_length("campaigns"."rules" -> 'events') BETWEEN 1 AND 10
                   ELSE false END),
	CONSTRAINT "campaigns_closed_pair" CHECK (("campaigns"."status" = 'closed') = ("campaigns"."closed_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "campaign_results_anonymized" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_results" ADD CONSTRAINT "campaign_results_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_results_campaign_rank_idx" ON "campaign_results" USING btree ("campaign_id","rank","id");--> statement-breakpoint
CREATE INDEX "campaign_results_user_idx" ON "campaign_results" USING btree ("user_id") WHERE "campaign_results"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_results_municipality_idx" ON "campaign_results" USING btree ("municipality_id") WHERE "campaign_results"."municipality_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_results_campaign_user_unique" ON "campaign_results" USING btree ("campaign_id","user_id") WHERE "campaign_results"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_results_campaign_municipality_unique" ON "campaign_results" USING btree ("campaign_id","municipality_id") WHERE "campaign_results"."municipality_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status","starts_on");--> statement-breakpoint
CREATE INDEX "campaigns_municipality_idx" ON "campaigns" USING btree ("municipality_id") WHERE "campaigns"."municipality_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
          AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
          AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
          AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0
          AND "account_deletions"."badges_erased" >= 0 AND "account_deletions"."campaign_results_anonymized" >= 0);--> statement-breakpoint
COMMENT ON TABLE "campaigns" IS 'A campaign is a ROW (an admin creates one without a deploy), but its scoring lives in the rules JSONB, validated against the closed grammar in lib/src/campaigns and compiled to one SQL aggregate. Creating a campaign is a form; inventing a new kind of scoring is a grammar change. Do not turn rules into columns.';--> statement-breakpoint
COMMENT ON COLUMN "campaigns"."ends_on" IS 'INCLUSIVE as authored, exclusive as compiled: the engine adds one CIVIL day and resolves it in Europe/Sofia. Treating it as exclusive here would discard the last and busiest day of every campaign.';--> statement-breakpoint
COMMENT ON COLUMN "campaigns"."rules" IS 'Validated scoring document: weighted event kinds, optional sports filter, optional per-day cap. The CHECK asserts coarse shape only - and uses CASE rather than AND, because a missing events key makes the conjunction NULL, which a CHECK accepts. The grammar itself is enforced in lib/src/campaigns/rules.ts.';--> statement-breakpoint
COMMENT ON TABLE "campaign_results" IS 'FROZEN final standings, written once at close. The public results page reads this rather than recomputing, so a late moderation reversal or an erasure cannot rewrite who won after prizes were announced. Deliberately holds NO display name: the placing is frozen, the identity is resolved live through leaderboard_eligible_members, so an erased or newly-private member keeps their rank without the system retaining their name.';--> statement-breakpoint
COMMENT ON CONSTRAINT "campaign_results_one_subject" ON "campaign_results" IS 'Both-NULL is deliberately legal: user_id is ON DELETE SET NULL, performed as an UPDATE that re-validates CHECKs, so demanding "exactly one subject" would abort DELETE FROM users forever (the 0009 lesson). A both-NULL row is an erased placing. This reading depends on municipality_id staying RESTRICT.';--> statement-breakpoint
-- Last: the three FKs that take SHARE ROW EXCLUSIVE on `users` and
-- `municipalities`, blocking every WRITE to them (sign-in upserts, profile
-- saves, GDPR erasure) until COMMIT. Kept to the final milliseconds of the
-- transaction, as 0009 does for the same reason.
ALTER TABLE "campaign_results" ADD CONSTRAINT "campaign_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_results" ADD CONSTRAINT "campaign_results_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id") REFERENCES "public"."municipalities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id") REFERENCES "public"."municipalities"("id") ON DELETE restrict ON UPDATE no action;
