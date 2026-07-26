-- Personal training logs — operator request 2026-07-26.
--
-- A member doing sport, whether or not anyone organised it. Everything the
-- product could previously say about a member came from contributions to the map
-- (`points_ledger`) or attendance at an organised session
-- (`play_session_checkins`); neither is participation. `/klasirane?sport=football`
-- reads like "who plays football" and actually ranks who EDITED football
-- pitches, because the only sport dimension available was the sport of the
-- facility a contribution was about. These tables are the missing dataset.
--
-- NO POINTS, by operator decision. There is deliberately no FK to
-- `points_ledger` and no new `points_event` value. `points_ledger` is
-- contribution-scoped and was hardened against farming BEFORE anything ranked it;
-- a self-reported number cannot be given that standing without handing the
-- strongest incentive in the product to whoever will type the largest figure.
-- Not adding a `points_event` also leaves `CAMPAIGN_EVENT_KINDS` untouched — it
-- is a SUBTRACTIVE filter, so a new kind would auto-render an admin checkbox and
-- compile to SQL matching a value that does not exist, scoring the campaign zero
-- with no error and no failing test.
--
-- THREE TABLES, AND THE SPLIT IS THE SECURITY MODEL.
--
--   training_logs      the hot, narrow table. Every board, division and campaign
--                      reads this and ONLY this.
--   training_routes    the GPS line (operator decision 2026-07-26).
--   training_metrics   heart rate and calories (operator decision 2026-07-26).
--
-- The operator asked for routes and health metrics after being shown what each
-- entails; the decision is recorded in docs/ENGAGEMENT-IMPLEMENTATION.md §8. The
-- separation is how that decision is made survivable rather than reversed:
--
--   * A future author writing a new board CANNOT leak a route or a heart rate,
--     because the table they are selecting from does not contain one.
--   * Withdrawing consent DELETES those rows while the training history stands.
--   * Neither table is on the open-data `ALLOWED_RELATIONS` allowlist, which is
--     default-deny. Do not add them.
--
-- WHY ROUTES ARE THE MOST SENSITIVE THING THIS SCHEMA HAS EVER HELD: a line that
-- starts at the same place most mornings is a home address plus a schedule. The
-- check-in path stores only `distance_m` and never a latitude or longitude
-- precisely to avoid this shape, so `training_routes` is the one deliberate
-- exception and is gated accordingly. There is no public read path, no heatmap
-- and no export; adding one is a NEW operator decision, not a new query — and
-- note there is deliberately NO GIST INDEX on the geometry, both because nothing
-- issues a spatial predicate against it and because that index is exactly what
-- would make the forbidden heatmap cheap. Its absence keeps the cost visible.
--
-- WHY HEART RATE IS ITS OWN TABLE AND ITS OWN CONSENT: heart rate and derived
-- calorie burn are SPECIAL-CATEGORY data under GDPR Art. 9, requiring EXPLICIT,
-- demonstrable, withdrawable consent under a different lawful basis from
-- everything else here. Four nullable columns on `training_logs` would travel
-- into every SELECT that ever touched a training, and the consent question would
-- have to be re-asked by every author forever. Elevation gain is deliberately
-- NOT there — it describes terrain, not a body.
--
-- CONSENT IS TWO SEPARATE FLAGS on `users`, both nullable timestamptz, NULL by
-- default and NULL again after withdrawal. Timestamps rather than booleans
-- because the obligation is to DEMONSTRATE consent. Two flags rather than one
-- because a member may reasonably want their route and not their heart rate, and
-- bundling two Art. 9 questions into one control is what makes consent
-- non-specific and therefore invalid.
--
-- ENFORCEMENT OF "NO ROW WITHOUT A RECORDED CONSENT" IS IN THE APPLICATION
-- (`attachRoute` / `attachMetrics` in db/src/training.ts, which THROW rather
-- than skip), asserted by tests. An earlier draft of this header justified that
-- by claiming a trigger would fire inside the erasure cascade; THAT IS WRONG and
-- is corrected here, because the wrong reason would stop the next author even
-- considering the option. The 0006 trap is about a DELETE-REFUSING trigger; a
-- BEFORE INSERT trigger reading `users.training_*_consent_at` would never fire
-- during a cascade, which issues only DELETEs. The real reason is the schema's
-- standing preference for an application rule with a test over a trigger that
-- reads a second table on every insert — a preference, not an impossibility, and
-- a future author may reasonably reverse it.
--
-- STRUCTURAL GUARANTEES on training_logs, weakest to strongest:
--
--   ..._duration_sane / _distance_sane / _elevation_sane / _note_len / _sport_shape
--                       bounded, because these rows are editable by their owner
--                       and land on a public surface. `sport` is free text so the
--                       vocabulary can grow without a migration, but that is not
--                       a reason to be unbounded: `participationSports` returns
--                       it RAW as the board's own filter menu.
--   ..._started_finite / _day_sane
--                       both time columns bounded at BOTH ends.
--                       `'infinity'::timestamptz` is legal, and such a row would
--                       pin itself to the top of `ORDER BY started_at DESC`
--                       forever while `-infinity` would win the board's
--                       `min(started_at)` tie-break permanently. `sofia_day`
--                       needs an UPPER bound too: every board window is
--                       `sofia_day >= X` with no upper bound, so a far-future row
--                       sits inside every rolling window for good. The `isfinite`
--                       half also closes the PG14 NULL-accepting-CHECK trap that
--                       0024/0025/0026 were written against.
--   ..._external_id_matches_source
--                       the dedupe key and the source must agree. Without it an
--                       import with a NULL external id re-inserts on EVERY sync.
--   ..._evidence_matches_source
--                       THE EVIDENCE RULE, and the reason it is a CHECK is
--                       migration 0014, which made the evidence tier structural
--                       for check-ins. A manual entry is `self_reported` and can
--                       be nothing else; an import is `connected_app` and can be
--                       nothing else. NOTE: the first draft of this CHECK said
--                       `evidence IN ('connected_app','qr_verified')` for a
--                       non-manual source, which permitted exactly what the
--                       comment beside it claimed to prevent — any importer could
--                       assert the top tier by passing a nicer string, and a
--                       prize surface filtering on that tier would have been
--                       filtering on an assertion. Pinned exactly now.
--   ..._user_source_external_unique
--                       IMPORT IDEMPOTENCY, SCOPED TO THE MEMBER, as a PARTIAL
--                       unique index. `user_id` LEADS, and its absence was a
--                       cross-account data-corruption bug: external ids are
--                       provider-local and often device-local (Apple Health and
--                       Google Fit hand out per-device ordinals), so two members
--                       can genuinely present the same `(source, external_id)`.
--                       Keyed on that pair alone, member B's import would take
--                       the ON CONFLICT path against member A's row and overwrite
--                       A's sport, time, duration and place while leaving
--                       `user_id` as A — then hand B A's row id, after which B's
--                       route and metrics writes would match zero rows and vanish
--                       with no error. PARTIAL because every manual row has a
--                       NULL external id and NULLs do not collide, but two syncs
--                       of the same activity must.
--
-- TWO EVIDENCE TIERS, NOT THREE. A `qr_verified` label was drafted and removed
-- before this shipped: nothing could produce it (no source for the check-in path,
-- and `evidenceFor` never returned it), so it would have been a PERMANENT enum
-- value — Postgres has no DROP VALUE, per 0014's header — that silently returned
-- an empty board to any prize surface asking for it. It comes back when something
-- can actually grant it, together with the source that does.
--
-- INDEXES ARE THE READ PATHS, and three of them are load-bearing rather than
-- speculative:
--   ..._day_sport_idx    the ALL-SPORTS board and `participationSports`, the
--                        board's own filter menu, filter on the DAY alone.
--                        `(sport, sofia_day)` cannot serve a range with no
--                        leading-column predicate, so without this a public page
--                        sequential-scans the fastest-growing table in the schema
--                        on every render, forever, with no pruning.
--   ..._user_started_idx `memberTrainings` is `WHERE user_id ORDER BY started_at
--                        DESC LIMIT 50`, which `(user_id, sofia_day)` cannot
--                        answer — Postgres would fetch a member's whole history
--                        and sort it on every page load.
--   ..._facility_day_idx `facilityParticipation` filters facility AND day; still
--                        a valid prefix for the SET NULL cascade from facilities.
-- All are created here, while the tables are empty, because a later addition
-- could not use CREATE INDEX CONCURRENTLY — drizzle wraps a migration run in one
-- transaction and Postgres rejects CONCURRENTLY inside one.
--
-- `sofia_day` IS STORED, NOT DERIVED: `timezone('Europe/Sofia', started_at)` is
-- STABLE rather than IMMUTABLE, so Postgres will not index it and every per-day
-- board would degrade into a sequential scan. It is computed by `bucketKeyFor` —
-- the one place in this codebase an instant becomes a calendar position — so a
-- training day, a streak day and a division week cannot disagree.
--
-- ERASURE: CASCADE from `users` through `training_logs` to both child tables.
-- Deliberately NO `account_deletions` counter, following `streak_freezes` (0025)
-- and `division_members` (0026): adding one is a four-place change and would
-- break the positional fixture in apps/web/tests/account-deletion.test.ts.
-- `facility_id` is ON DELETE SET NULL rather than RESTRICT — a member's own
-- history must not block an admin from removing a facility that turned out not to
-- exist, and `municipality_id` survives to keep the row useful to a city board.
--
-- LOCK NOTE, corrected from an earlier draft. The strongest lock here is NOT the
-- foreign keys: `ALTER TABLE "users" ADD COLUMN` takes ACCESS EXCLUSIVE on
-- `users`, which blocks READS including sign-in, and holds it to COMMIT. Both
-- columns are nullable with no default, so they are catalogue-only in PG11+ and
-- rewrite nothing, and they are placed immediately before the FK block so the
-- window covers as little as possible. Everything else here touches tables made
-- empty in this same transaction, so every lock is held for microseconds and
-- `lock_timeout = '3s'` fails the deploy rather than stalling it.
--
-- JOURNAL NOTE: drizzle-kit stamps from the real clock, which is BEHIND 0026's
-- hand-set 1785091200000 — the future-timestamp trap first hit at 0019. Left
-- alone this file would be silently skipped: exit 0, deploy green, tables absent.
-- The entry is hand-bumped to 1785094800000.
--
-- rollback (compensating SQL; ONE explicit transaction, since `SET LOCAL`
-- outside a transaction block is a no-op with a WARNING). ROLL THE APPLICATION
-- BACK FIRST — db/src/index.ts exports these readers and /trenirovki and
-- /klasirane call them, so rolling the schema back under a build that still does
-- turns those pages into `relation does not exist` 500s:
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   DROP TABLE "training_routes";
--   DROP TABLE "training_metrics";
--   DROP TABLE "training_logs";
--   ALTER TABLE "users" DROP COLUMN "training_route_consent_at";
--   ALTER TABLE "users" DROP COLUMN "training_health_consent_at";
--   DROP TYPE "public"."training_evidence";
--   DROP TYPE "public"."training_source";
--   COMMIT;
-- Children first — both point at training_logs. Destructive of member-entered
-- data, so it is a rollback of last resort; note especially that dropping the two
-- `users` columns destroys the CONSENT-DEMONSTRATION RECORD itself, which is the
-- one artefact a regulator would ask to see.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TYPE "public"."training_evidence" AS ENUM('self_reported', 'connected_app');;
--> statement-breakpoint
CREATE TYPE "public"."training_source" AS ENUM('manual', 'strava', 'garmin', 'apple_health', 'google_fit', 'polar', 'suunto', 'other');;
--> statement-breakpoint
CREATE TABLE "training_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"sport" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"sofia_day" date NOT NULL,
	"duration_s" integer NOT NULL,
	"distance_m" integer,
	"elevation_m" integer,
	"facility_id" uuid,
	"municipality_id" integer,
	"source" "training_source" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"evidence" "training_evidence" DEFAULT 'self_reported' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_logs_duration_sane" CHECK ("training_logs"."duration_s" BETWEEN 60 AND 86400),
	CONSTRAINT "training_logs_sport_shape" CHECK ("training_logs"."sport" ~ '^[a-z_]{2,40}$'),
	CONSTRAINT "training_logs_distance_sane" CHECK ("training_logs"."distance_m" IS NULL OR "training_logs"."distance_m" BETWEEN 0 AND 1000000),
	CONSTRAINT "training_logs_elevation_sane" CHECK ("training_logs"."elevation_m" IS NULL OR "training_logs"."elevation_m" BETWEEN 0 AND 30000),
	CONSTRAINT "training_logs_note_len" CHECK ("training_logs"."note" IS NULL OR char_length("training_logs"."note") <= 500),
	CONSTRAINT "training_logs_started_finite" CHECK (isfinite("training_logs"."started_at")),
	CONSTRAINT "training_logs_day_sane" CHECK (isfinite("training_logs"."sofia_day") AND "training_logs"."sofia_day" BETWEEN DATE '2020-01-01' AND DATE '2100-01-01'),
	CONSTRAINT "training_logs_evidence_matches_source" CHECK (("training_logs"."source" = 'manual' AND "training_logs"."evidence" = 'self_reported')
          OR ("training_logs"."source" <> 'manual' AND "training_logs"."evidence" = 'connected_app')),
	CONSTRAINT "training_logs_external_id_matches_source" CHECK (("training_logs"."source" = 'manual' AND "training_logs"."external_id" IS NULL)
          OR ("training_logs"."source" <> 'manual' AND "training_logs"."external_id" IS NOT NULL))
);;
--> statement-breakpoint
CREATE TABLE "training_metrics" (
	"training_log_id" uuid PRIMARY KEY NOT NULL,
	"avg_heart_rate" integer,
	"max_heart_rate" integer,
	"calories_kcal" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_metrics_avg_hr_sane" CHECK ("training_metrics"."avg_heart_rate" IS NULL OR "training_metrics"."avg_heart_rate" BETWEEN 20 AND 260),
	CONSTRAINT "training_metrics_max_hr_sane" CHECK ("training_metrics"."max_heart_rate" IS NULL OR "training_metrics"."max_heart_rate" BETWEEN 20 AND 260),
	CONSTRAINT "training_metrics_calories_sane" CHECK ("training_metrics"."calories_kcal" IS NULL OR "training_metrics"."calories_kcal" BETWEEN 0 AND 30000),
	CONSTRAINT "training_metrics_not_empty" CHECK (num_nonnulls("training_metrics"."avg_heart_rate", "training_metrics"."max_heart_rate", "training_metrics"."calories_kcal") > 0),
	CONSTRAINT "training_metrics_max_ge_avg" CHECK ("training_metrics"."max_heart_rate" IS NULL OR "training_metrics"."avg_heart_rate" IS NULL
          OR "training_metrics"."max_heart_rate" >= "training_metrics"."avg_heart_rate")
);;
--> statement-breakpoint
CREATE TABLE "training_routes" (
	"training_log_id" uuid PRIMARY KEY NOT NULL,
	"geom" geometry(LineString,4326) NOT NULL,
	"point_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_routes_point_count_matches" CHECK ("training_routes"."point_count" BETWEEN 2 AND 100000 AND ST_NumPoints("training_routes"."geom") = "training_routes"."point_count"),
	CONSTRAINT "training_routes_coords_sane" CHECK (ST_XMin("training_routes"."geom") >= -180 AND ST_XMax("training_routes"."geom") <= 180
          AND ST_YMin("training_routes"."geom") >= -90 AND ST_YMax("training_routes"."geom") <= 90)
);;
--> statement-breakpoint
CREATE INDEX "training_logs_user_day_idx" ON "training_logs" USING btree ("user_id","sofia_day");;
--> statement-breakpoint
CREATE INDEX "training_logs_user_started_idx" ON "training_logs" USING btree ("user_id","started_at" DESC NULLS LAST);;
--> statement-breakpoint
CREATE INDEX "training_logs_sport_day_idx" ON "training_logs" USING btree ("sport","sofia_day");;
--> statement-breakpoint
CREATE INDEX "training_logs_day_sport_idx" ON "training_logs" USING btree ("sofia_day","sport");;
--> statement-breakpoint
CREATE INDEX "training_logs_municipality_day_idx" ON "training_logs" USING btree ("municipality_id","sofia_day");;
--> statement-breakpoint
CREATE INDEX "training_logs_facility_day_idx" ON "training_logs" USING btree ("facility_id","sofia_day");;
--> statement-breakpoint
CREATE UNIQUE INDEX "training_logs_user_source_external_unique" ON "training_logs" USING btree ("user_id","source","external_id") WHERE "training_logs"."external_id" IS NOT NULL;;
--> statement-breakpoint
COMMENT ON TABLE "training_logs" IS 'Personal training a member logged or imported, whether or not anyone organised it. The HOT, NARROW table: every board, division and campaign reads this and only this. Awards NO points (operator decision 2026-07-26) — points_ledger is contribution-scoped and was hardened against farming before anything ranked it. GPS routes and heart rate live in training_routes and training_metrics, separately and behind their own consents, so a query here cannot expose them.';
--> statement-breakpoint
COMMENT ON TABLE "training_routes" IS 'GPS route for one imported training. The most sensitive thing in this schema: a line starting at the same place most mornings is a home address plus a schedule. Written ONLY by db/src/training.ts attachRoute, which throws without users.training_route_consent_at; withdrawing consent deletes every row for that member while their training history stands. No public read path, no heatmap, no export, no GIST index (which is what would make a heatmap cheap), and NOT on the open-data ALLOWED_RELATIONS allowlist. Adding any of those is a new operator decision, not a new query.';
--> statement-breakpoint
COMMENT ON TABLE "training_metrics" IS 'Heart rate and calories from a connected app. SPECIAL-CATEGORY health data under GDPR Art. 9: explicit, demonstrable, withdrawable consent, recorded as users.training_health_consent_at. Written ONLY by db/src/training.ts attachMetrics, which throws without it. Nothing scores on this table — effort-adjusted scoring would be a new operator decision, because it would make a prize depend on health data. NOT on the open-data allowlist.';
--> statement-breakpoint
COMMENT ON COLUMN "training_logs"."sofia_day" IS 'The civil Sofia day, computed in TypeScript by bucketKeyFor and STORED. Never derived in SQL: timezone(''Europe/Sofia'', started_at) is STABLE not IMMUTABLE, so Postgres will not index it and every per-day board would become a sequential scan.';
--> statement-breakpoint
COMMENT ON COLUMN "training_logs"."evidence" IS 'How far the row can be trusted, pinned EXACTLY by training_logs_evidence_matches_source: a manual entry is self_reported and can be nothing else, an import is connected_app and can be nothing else. Two tiers, not three — a qr_verified label was drafted and removed because nothing could grant it and an enum value cannot be dropped. Same principle migration 0014 made structural for check-ins.';
--> statement-breakpoint
CREATE TRIGGER "training_logs_set_updated_at"
BEFORE UPDATE ON "training_logs"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "training_route_consent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "training_health_consent_at" timestamp with time zone;
--> statement-breakpoint
COMMENT ON COLUMN "users"."training_route_consent_at" IS 'When the member explicitly consented to GPS routes being stored. NULL means no consent — the default and the state after withdrawal, which also deletes their training_routes rows. A timestamp rather than a boolean because the obligation is to DEMONSTRATE consent.';
--> statement-breakpoint
COMMENT ON COLUMN "users"."training_health_consent_at" IS 'When the member explicitly consented to heart rate and calories being stored — GDPR Art. 9 special-category data, so a different lawful basis from everything else on this row. Separate from the route consent on purpose: bundling two Art. 9 questions into one control makes consent non-specific and therefore invalid.';
--> statement-breakpoint
ALTER TABLE "training_logs" ADD CONSTRAINT "training_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_logs" ADD CONSTRAINT "training_logs_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_logs" ADD CONSTRAINT "training_logs_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id") REFERENCES "public"."municipalities"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_metrics" ADD CONSTRAINT "training_metrics_training_log_id_training_logs_id_fk" FOREIGN KEY ("training_log_id") REFERENCES "public"."training_logs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_routes" ADD CONSTRAINT "training_routes_training_log_id_training_logs_id_fk" FOREIGN KEY ("training_log_id") REFERENCES "public"."training_logs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
