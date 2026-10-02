-- Trainings logged at a facility never recorded that facility's municipality.
--
-- WHY THIS MIGRATION EXISTS. `training_logs.municipality_id` is the only column
-- the city participation board reads (`sportParticipationBoard` with
-- `municipalityId`, behind /klasirane?grad=…), and 0027 kept it expressly "to keep
-- the row useful to a city board". But no writer ever set it. The one production
-- writer, logTrainingAction, passes a facility and no municipality;
-- recordTraining stored that NULL; nothing derived it, and 0027 has no trigger
-- that would. So every row is NULL, and the board that leads /klasirane?grad=… is
-- empty in every city however many members train there.
--
-- recordTraining now takes the municipality from the facility
-- (db/src/training.ts) — in the application rather than a trigger, following
-- 0027's stated preference for an application rule with a test over a trigger
-- that reads a second table on every insert. This file backfills the rows
-- written before that.
--
-- SCOPE, and why it is safe to run twice. Only rows that HAVE a facility whose
-- municipality is known, and only where the column is still NULL: it can never
-- overwrite a value an importer supplied, and a re-run — or a second deploy of
-- the same batch — updates zero rows. A training with no facility stays NULL;
-- there is nothing true to derive it from.
--
-- `updated_at` moves on the touched rows (0027's set_updated_at trigger). That is
-- honest — the row did change — and nothing reads updated_at as "the member
-- edited this".
--
-- DATA ONLY, NO DDL, so no drizzle snapshot and no schema change. A plain UPDATE
-- takes ROW EXCLUSIVE on training_logs, which blocks no reader, and the table
-- holds only manual entries logged since 2026-07-26. lock_timeout still fails the
-- deploy fast rather than letting it queue behind the nightly backup.
--
-- JOURNAL NOTE: hand-stamped 1785123600000 — one hour per index past 0030's
-- 1785105600000 — so the other migrations of this pre-launch batch (0031–0034)
-- slot in between without reordering (db/src/journal.test.ts).
--
-- rollback: none needed, and none recommended. The values written are the
-- facilities' own municipalities, which the previous application build reads
-- correctly and never writes; rolling the application back simply stops new
-- rows getting one. NULLing them again would only re-empty every city board.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
UPDATE "training_logs" t
   SET "municipality_id" = f."municipality_id"
  FROM "facilities" f
 WHERE f."id" = t."facility_id"
   AND t."municipality_id" IS NULL
   AND f."municipality_id" IS NOT NULL;--> statement-breakpoint
-- The migrator runs the whole pending batch in ONE transaction, so a
-- SET LOCAL leaks into the next migration file; reset like 0020..0029 do.
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
