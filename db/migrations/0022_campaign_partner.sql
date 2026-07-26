-- 0022_campaign_partner: sponsored campaigns (docs/MONETISATION.md S2, M2).
--
-- ONE NULLABLE FK, AND THAT IS THE WHOLE FEATURE. The campaign engine (0012)
-- was already structurally safe for sponsorship: scoring counts everyone,
-- display is gated by the consent view, prizes are free-text columns, and
-- closing freezes standings that carry no display name. So a sponsor is a
-- REFERENCE to the M1 registry, not copied name/logo/url columns per campaign.
-- The consequence is the one that matters operationally: hiding a partner, or
-- letting their window lapse, removes the "с подкрепата на" line from every
-- campaign at once, because the sponsor block reads through the same
-- renderability rule `/partnyori` uses.
--
-- ON DELETE RESTRICT. A campaign that said "supported by X" keeps saying so; a
-- partner with a sponsored campaign is HIDDEN (visible=false), never deleted —
-- the posture 0019 established for exactly this reason.
--
-- WHAT A SPONSOR STILL CANNOT BUY, unchanged by this column: novel scoring (the
-- `rules` grammar is closed — a new kind of scoring is a deploy and a test),
-- participant identities (the public individual board joins
-- `leaderboard_eligible_members`; the admin board is requireRole('admin') and
-- exists so the OPERATOR can hand over a prize), and any presence in
-- `campaign_results`, which deliberately stores no display data at all.
--
-- THE INDEX IS PARTIAL. Almost every campaign is unsponsored, so indexing the
-- NULLs would be overhead for no reader. The query that needs it is "does this
-- partner have campaigns" — asked before hiding or retiring a partner.
--
-- LOCKING. Three locks, all stated. ADD COLUMN with no default is catalog-only
-- (PG11+): no rewrite, no scan. CREATE INDEX (not CONCURRENTLY — impossible
-- inside drizzle's single transaction, and unnecessary on tens of rows) takes a
-- SHARE lock that blocks writes to `campaigns`, not reads. ADD CONSTRAINT …
-- FOREIGN KEY does take ACCESS EXCLUSIVE on `campaigns`
-- and a ShareRowExclusive lock on `partners`, and it validates existing rows —
-- but every existing row has partner_id NULL, so validation is trivial and
-- `campaigns` is a table with tens of rows. Guards first, reset at the end
-- (0020's pattern: drizzle runs the whole run in one transaction, so an
-- un-reset timeout would leak into later migrations of the same run).
--
-- rollback (compensating SQL — loses which campaigns were sponsored, nothing
-- else). ONE EXPLICIT TRANSACTION: psql autocommits per statement and `SET LOCAL`
-- outside a transaction block is a no-op with a WARNING, so run loose these
-- ALTERs would wait unbounded for ACCESS EXCLUSIVE on `campaigns` and queue every
-- reader of the campaign pages behind them.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   DROP INDEX IF EXISTS "campaigns_partner_idx";
--   ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_partner_id_partners_id_fk";
--   ALTER TABLE "campaigns" DROP COLUMN "partner_id";
--   COMMIT;
--
-- JOURNAL: idx 22 is hand-stamped 1785076800000 — see 0020's header for why the
-- generated real-clock value is too low to be applied.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "partner_id" bigint;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_partner_idx" ON "campaigns" USING btree ("partner_id") WHERE "campaigns"."partner_id" IS NOT NULL;--> statement-breakpoint
COMMENT ON COLUMN "campaigns"."partner_id" IS 'The campaign''s sponsor (MONETISATION S2), referencing partners — never copied name/logo columns, so hiding a partner or letting their window lapse withdraws the sponsor line from every campaign at once. RESTRICT: a partner with a sponsored campaign is hidden, never deleted. Buys a branding line and nothing else: not scoring (the rules grammar is closed), not participant identities, and no presence in campaign_results.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
