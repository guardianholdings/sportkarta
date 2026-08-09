-- Contribution proximity — how far the contributor was from the place they were
-- describing (operator decision 2026-08-07).
--
-- WHY. A crowd contribution is a claim about the physical world: this pitch
-- exists, its surface is broken, it is still there. Until now nothing recorded
-- whether the person making the claim was anywhere near it, so a fabricated pin
-- and a pin dropped by somebody standing on the touchline were indistinguishable
-- at every later stage — moderation, scoring and the merge policy all treated
-- them alike. This column is the distinguishing signal.
--
-- METRES, NEVER A COORDINATE. The browser hands the server a latitude and a
-- longitude; they live for exactly one statement — the one that turns them into
-- metres — and only the metres are written here. This is the same rule, for the
-- same reason, that `play_session_checkins.distance_m` follows (0014): a column
-- of coordinates is a record of where named people physically were, and this
-- platform deliberately does not keep one. Do not add a lat/lon column beside
-- this one; if a future feature seems to need it, that is a new operator
-- decision about surveillance, not a schema convenience.
--
-- NULL IS MEANINGFUL AND IS NOT ZERO. NULL = no position was offered (permission
-- denied, unsupported, timed out, or a desktop with no fix). It must stay
-- distinguishable from a large number, which means "we know where they were and
-- it was not here". The application treats both as not-on-site, but they are
-- different facts and a later report that conflated them would be wrong.
--
-- IT DOES NOT GATE WRITES. Nothing in this migration refuses a contribution, and
-- nothing downstream may start doing so on the strength of this column alone:
-- browser geolocation is self-reported and trivially spoofable, so the value is
-- EVIDENCE, never proof. What it does gate, in application code, is trust — a
-- contribution made away from the site lands as `needs_verification` and earns
-- no points, which is what makes bulk faking pointless without costing honest
-- contributors their edit. See apps/web/lib/contributions/proximity.ts.
--
-- BOUND. 1 000 km, matching `play_session_checkins_distance_sane` (0014). The
-- application clamps before insert; this CHECK is the backstop. An unclamped
-- spoofed coordinate can be 20 000 km out, and a constraint violation there
-- would abort the transaction and destroy the whole contribution — turning an
-- anti-abuse signal into a way to delete honest data.
--
-- LOCKING, and why there is no VALIDATE step.
--
-- Every statement in a migration file runs inside ONE transaction (the same rule
-- 0014 and 0027 record for enums and CONCURRENTLY). So a `VALIDATE CONSTRAINT`
-- here would NOT take the gentle SHARE UPDATE EXCLUSIVE it takes on its own: the
-- ACCESS EXCLUSIVE taken by the ADD COLUMN above is still held by the same
-- session, and the validation scan of facility_edits — the largest table in the
-- schema, one row per changed field per import — would run with every reader and
-- writer of it blocked behind us.
--
-- It is also unnecessary. The column is brand new, so every existing row is
-- NULL, and NULL satisfies the CHECK; there is nothing for a scan to discover.
-- A NOT VALID constraint is still enforced on every INSERT and UPDATE from the
-- moment it exists — "NOT VALID" means "not verified against rows that were
-- already here", not "not enforced". So the constraint binds all future writes,
-- which is the only thing it needs to do, and the table is locked for a
-- catalogue update rather than a sequential scan.
--
-- The two ADD COLUMNs are catalogue-only (Postgres 11+ adds a nullable column
-- with no default without a rewrite). lock_timeout below makes the whole thing
-- fail fast rather than queue behind a long reader — an ACCESS EXCLUSIVE request
-- blocks every later reader while it waits, so a deploy landing during the
-- nightly backup (which holds ACCESS SHARE on every table for the length of the
-- dump) would otherwise take the contribution paths down with it.
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE — drops the signal).
-- ROLL THE APPLICATION BACK FIRST: apps/web/lib/contributions/proximity.ts writes
-- this column on every add, verify, condition report and problem report, so
-- dropping it under a running build fails each of those with
-- `42703 column "distance_m" does not exist` — i.e. adding a facility and
-- reporting a problem both go down.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE "facility_reports" DROP COLUMN "distance_m";
--   ALTER TABLE "facility_edits" DROP COLUMN "distance_m";
--   COMMIT;
--   -- (the CHECK constraints go with their columns)

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "facility_edits" ADD COLUMN "distance_m" integer;--> statement-breakpoint
ALTER TABLE "facility_reports" ADD COLUMN "distance_m" integer;--> statement-breakpoint
ALTER TABLE "facility_edits" ADD CONSTRAINT "facility_edits_distance_sane"
  CHECK ("distance_m" IS NULL OR "distance_m" BETWEEN 0 AND 1000000) NOT VALID;--> statement-breakpoint
ALTER TABLE "facility_reports" ADD CONSTRAINT "facility_reports_distance_sane"
  CHECK ("distance_m" IS NULL OR "distance_m" BETWEEN 0 AND 1000000) NOT VALID;--> statement-breakpoint
COMMENT ON COLUMN "facility_edits"."distance_m" IS
  'Metres between the contributor and the facility when the claim was made. NULL = no position offered; never a coordinate. Evidence, not proof — see apps/web/lib/contributions/proximity.ts.';--> statement-breakpoint
COMMENT ON COLUMN "facility_reports"."distance_m" IS
  'Metres between the reporter and the facility when the report was filed. NULL = no position offered; never a coordinate.';
