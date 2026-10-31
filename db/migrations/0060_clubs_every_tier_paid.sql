-- 0060_clubs_every_tier_paid: «Клубове» — every tier is paid (operator
-- decision 2026-10-31). Hand-written; do not regenerate.
--
-- WHAT CHANGED IN THE APPLICATION
--
-- The community tier was free and never lapsed: the write rule read
--   status = 'active' AND (tier = 'community'
--                          OR greatest(paid_until, trial_ends_on) + 14 >= today)
-- and approveClub granted the 30-day trial on the paid tiers only. Every
-- tier now has a monthly fee and starts with a one-month trial, so the rule
-- lost its community clause (apps/web/lib/clubs/access.ts clubWritableSql and
-- its twins in db/src/clubs) and approval grants the trial on any tier.
--
-- WHAT THIS DOES
--
-- A community club approved before that change has NEITHER date, and the new
-- rule would make it read-only at once: its page withdrawn, its kiosk dark,
-- and no mail to say so (no lifecycle milestone matches a NULL coverage).
-- This gives each such club the trial it would get if approved today: 30
-- days (CLUB_TRIAL_DAYS) from the Sofia date of the deploy.
--
--   - community clubs only: a standard or pro club with neither date is one
--     the operator withdrew on purpose (setClubPlan can clear both), and it
--     stays read-only;
--   - approved clubs only (approved_at set), whatever their status now: an
--     active one keeps working, and a suspended or archived one — both can be
--     reinstated (setClubStatus) — comes back inside a trial rather than
--     read-only. The trial runs down while it is suspended or archived, as a
--     paid club's coverage does; the lifecycle mails only go to active
--     clubs, so a club reinstated more than 44 days later is read-only at
--     once, exactly like a paid-tier club today;
--   - a pending club (no approved_at) gets its trial at approval;
--   - a club with either date is left alone, so a re-run touches no row.
--
-- Production has run with CLUBS_ENABLED off (every club route, the
-- application included, 404s), so no rows are expected there; local and
-- staging databases with applied community clubs are what this repairs.
-- The table comment, which still described the community clause, is
-- refreshed.
--
-- Locking: the UPDATE takes ROW EXCLUSIVE on clubs and FOR NO KEY UPDATE on
-- the matched rows only (expected: none in production; no key column
-- changes); COMMENT ON TABLE takes SHARE UPDATE EXCLUSIVE until COMMIT and
-- blocks neither reads nor row writes. In the batch that first deploys this
-- branch (0045–0060 in one transaction) clubs is already held in ACCESS
-- EXCLUSIVE by earlier files and nothing new is acquired.
--
-- rollback: revert the web app AND the worker in the same deploy (the
-- worker's lifecycle mails now cover every tier; with only the web reverted,
-- community clubs would be mailed about a trial the web ignores). The dates
-- are then harmless — the restored community clause makes the club writable
-- either way — and may stay. To clear them anyway, clubs_set_updated_at
-- stamped exactly the touched rows with the migration's now():
--   UPDATE "clubs" SET "trial_ends_on" = NULL
--    WHERE "tier" = 'community' AND "paid_until" IS NULL
--      AND "trial_ends_on" = DATE '<deploy Sofia date>' + 30
--      AND "updated_at" = TIMESTAMPTZ '<the migrate step''s transaction start>';
-- A corrective migration needs a journal `when` above 1785213600000.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
UPDATE "clubs"
   SET "trial_ends_on" = (now() AT TIME ZONE 'Europe/Sofia')::date + 30
 WHERE "tier" = 'community'
   AND "approved_at" IS NOT NULL
   AND "trial_ends_on" IS NULL
   AND "paid_until" IS NULL;--> statement-breakpoint
COMMENT ON TABLE "clubs" IS 'A tenant of the «Клубове» add-on: a gym, studio, club or trainer. The club is the CONTROLLER of its client records, POPS the processor. Entitlement to write is derived (apps/web/lib/clubs/access.ts clubWritableSql: active AND greatest(paid_until, trial_ends_on) + 14 days >= Sofia today, on every tier — 0060 withdrew the free community tier; with neither date a club may not write), never stored. Not on the open-data ALLOWED_RELATIONS.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
