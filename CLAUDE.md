# SportKarta

NGO platform: national map of free public sports facilities in Bulgaria,
plus pickup sessions and a gamified sports passport. Bulgarian-first (bg
default). Self-hosted stack. The operator works ONLY through the Claude Code
desktop app — never instruct them to run terminal commands; run them
yourself, and put GUI-only steps (Finder, GitHub Desktop, Docker Desktop,
browser) in a MANUAL STEPS list at the end of the session.

## Commands (run them yourself)

- `pnpm dev` — Next.js dev server (apps/web)
- `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test` — fan out across the workspace
- `pnpm test:e2e` — Playwright smoke tests (apps/web/e2e); needs the dev db up + migrated + seeded
- `pnpm db:start` — dev Postgres+PostGIS via compose (host port **5433**, not 5432)
- `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:seed` — drizzle-kit + seed in db/
- `pnpm db:reset` — destroy LOCAL dev db volume, re-init, migrate, seed
- `docker compose -f compose.dev.yml up -d --wait` — full local stack (db, Umami :3001, GlitchTip :3002)

## Repository layout (pnpm workspace monorepo)

- `apps/web` — Next.js App Router, TS strict, `output: "standalone"`; server components default
- `apps/worker` — pg-boss worker process (reminders, digests, imports)
- `db` — Drizzle schema in `db/schema`; geospatial = raw SQL in `db/geo`; migrations in `db/migrations`
- `lib` — shared code; storage adapter interface in `lib/src/storage` (local-volume impl; MinIO/S3 swap must stay trivial)
- `scripts` — operational scripts (OSM import etc., Stage 1+)
- `deploy/` — compose.prod.yml, Caddyfile, cloud-init.yml, backup sidecar; shipped to the VPS by deploy.yml (never hand-edited on the server)
- `docs/ROADMAP.md` — the plan; read it at session start

## Architecture

- EPSG:4326 everywhere; `geometry(Point,4326)`; GIST indexes mandatory
- Query building goes through `sql` re-exported from `@sportkarta/db` — never
  import `drizzle-orm` directly outside `db/`, or pnpm's peer resolution can
  create a second drizzle instance whose types no longer match. Bind arrays with
  `sql.param(...)`: a bare array expands to `($1, $2)`, which Postgres rejects
- better-auth (self-hosted) in `apps/web/lib/auth.ts`: email OTP through the
  mail abstraction, Google behind `AUTH_GOOGLE_ENABLED` (ships off). Roles are
  `user < ambassador < admin` (`apps/web/lib/roles.ts`); the first admin comes
  from `ADMIN_EMAILS`. Authorization reads the role from the database, never
  from the session cookie cache. pg-boss for jobs (apps/worker)
- Moderation is municipality-scoped: an ambassador's authority is the rows in
  `ambassador_municipalities`, not their rank, and the scope is part of every
  statement (`apps/web/lib/moderation.ts`) so an out-of-scope decision updates
  zero rows. `requireAdmin()` means "ambassador or admin" — admin-only paths
  use `requireRole('admin')`. Every decision is logged to the append-only
  `moderation_decisions`; `moderation_flags` are assistive and never decide
  anything (`docs/prompts/moderation-prescreen.md`)
- Contributions (`apps/web/lib/contributions/*`): add / verify / condition-report
  all write through `facility_edits` with the account id as `actor` and
  `source='crowd'`. Points live in the append-only `points_ledger` — awards are
  `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` inside the contribution's
  own transaction, so retries cannot double-award. Earning only — there are no
  spending mechanics
- Passport + leaderboards (Stage 5): badges are DERIVED by folding
  `points_ledger` + `play_session_checkins` through the catalogue in
  `lib/src/badges` — a new badge is config plus two i18n keys, never a
  migration, and is awarded retroactively with its true date. Streaks are
  civil Sofia days/weeks (never elapsed ms). Who may appear on a public
  leaderboard is defined ONCE, in the `leaderboard_eligible_members` view:
  never a minor, and only members who opted their passport public. Every
  ranking joins that view instead of `users`, so a new slice inherits the rule
- Client components must import `@sportkarta/lib/<subpath>`, never the barrel:
  the barrel re-exports the mailer, which drags nodemailer and `node:fs` into
  the browser bundle (`apps/web/tests/client-imports.test.ts` enforces this)
- Mail: `Mailer` interface in `lib/src/email` (smtp | file | console | memory).
  Production without SMTP sends nothing — a one-time code must never fall back
  to a log or a file. Locally, codes land in `apps/web/var/mail`
- Tiles: self-served pmtiles at /tiles; MapLibre style lives in apps/web (Stage 2)
- i18n: next-intl; NEVER hardcode UI strings; `apps/web/messages/bg.json` is the
  source of truth, en mirrors it (parity enforced by `apps/web/tests/i18n.test.ts`);
  "/" deterministically serves bg — no Accept-Language negotiation

## Rules

- Provenance on every facility record; crowd-verified fields never
  overwritten by imports (merge policy: crowd > municipal > osm)
- OSM/Protomaps attribution on every map view and export
- No PII in logs; no identifiable people in photos
- Date of birth is derived to `is_minor` and discarded — never a column, never a
  log line (`lib/src/age.ts`, proven by `apps/web/tests/dob-not-persisted.test.ts`)
- Session IPs are never persisted (CHECK-enforced on `sessions.ip_address`)
- GDPR erasure removes the profile and anonymises contributions, but
  `facility_edits` is append-only and stays intact — erased actors render as the
  "former user" label (`apps/web/lib/account-deletion.ts`)
- Minors: no individual public leaderboards. Leaderboards exist (Stage 5.2) and
  minors are excluded from them at the QUERY layer, by the
  `leaderboard_eligible_members` view — never by a UI check. That view must
  never be widened; adding a board means a new query against it
- Migrations forward-only, reviewed by db-migration-reviewer subagent
- Deploys happen ONLY via GitHub Actions on main — never deploy from a session
- Secrets: real values live only in `.env` (gitignored), GitHub Actions
  secrets, and the VPS; `.env.example` documents every variable with dummy values
