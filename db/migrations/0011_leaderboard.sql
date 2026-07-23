-- 0011_leaderboard: leaderboard eligibility as a VIEW (docs/ROADMAP.md §7,
-- Stage 5.2). No table, no column, no data change — one view and its comment.
--
-- WHY A VIEW AND NOT A WHERE CLAUSE. docs/ROADMAP.md §7 requires "minor
-- protection enforced at the query layer and attacked in tests", and §0's legal
-- constants — binding, unchanged since v1 — say minors are NEVER on individual
-- public leaderboards. A predicate copied into each of the national, per-city
-- and per-sport queries is three chances to forget it, and the fourth slice
-- somebody adds next year is a fourth. So eligibility is written down ONCE, and
-- the application has no query that reads `users` for a ranking at all: it
-- joins this view, and a future slice that joins it inherits the protection
-- without its author having to know the rule exists.
--
-- This is the same move as `play_session_rsvp_positions` in 0008 (one
-- definition of waitlist position) and as the municipality join in the
-- moderation statements (0007): put the rule in the SQL, so bypassing the
-- application does not bypass the rule.
--
-- THE THREE CONDITIONS, AND WHY EACH IS THERE:
--
--   is_minor = false            The legal constant. A ranked, named, publicly
--                               readable list of children by how much they play
--                               and where is exactly the exposure the rule
--                               exists to prevent.
--   profile_visibility='public' Consent. Appearing on a public leaderboard IS an
--                               individual public profile — it publishes a name
--                               next to an activity level. Members who signed up
--                               before this feature existed never agreed to
--                               that, and a leaderboard is not a legal basis for
--                               publishing them. So the gate is the same opt-in
--                               that publishes a passport (0010): the board is a
--                               ranked index of passports people chose to make
--                               public, not a census of the membership.
--   public_handle IS NOT NULL   A rank with no passport to link to is a name
--                               published for nothing. Redundant against
--                               users_public_needs_handle, and kept because this
--                               view must be correct on its own terms.
--
-- THIS VIEW MUST NEVER BE WIDENED. Adding members to it is publishing people,
-- and the two predicates that matter are a legal constant and a consent record.
-- A new slice of the board is a new query AGAINST this view; it is never a
-- reason to relax the view. db/src/leaderboard-authz.test.ts attacks exactly
-- that, straight against Postgres with no application in the picture.
--
-- Deliberately NOT here: points, ranks or any aggregate. Eligibility is a
-- property of a member; a ranking is a property of a question (which city,
-- which sport, which period). Baking one ranking into the view would make the
-- other slices either wrong or a second definition.
--
-- security_invoker, matching 0008: the day a read-only reporting role is
-- granted this view, it must not become a way around the permissions on
-- `users` underneath it.
--
-- No lock_timeout: CREATE VIEW takes no lock on the referenced table beyond a
-- brief catalog read, and nothing here rewrites or scans anything.
--
-- rollback: fully reversible, destroys nothing. The view holds no data and the
-- leaderboard simply stops resolving.
--   DROP VIEW "leaderboard_eligible_members";
CREATE VIEW "leaderboard_eligible_members" WITH (security_invoker = true) AS
SELECT
  u.id,
  u.public_handle,
  u.display_name,
  u.home_city
FROM users u
WHERE u.is_minor = false
  AND u.profile_visibility = 'public'
  AND u.public_handle IS NOT NULL;--> statement-breakpoint
COMMENT ON VIEW "leaderboard_eligible_members" IS 'The ONE definition of who may appear on a public leaderboard: not a minor (binding legal constant — minors are never on individual public leaderboards), has opted their passport public (appearing on a ranked public list is individual public exposure and needs consent), and has a handle to link to. Every leaderboard slice joins this view rather than users, so a new slice inherits the rule. MUST NEVER BE WIDENED.';
