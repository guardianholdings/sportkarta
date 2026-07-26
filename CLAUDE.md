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
- **NEVER run `pnpm build` while `pnpm dev` is up.** Both write `apps/web/.next`,
  and the race corrupts `prerender-manifest.json` — every page then 500s with
  `SyntaxError: Unexpected non-whitespace character after JSON`, which looks like
  an application bug and is not. Recovery: stop the dev server, confirm no
  `next dev`/`next-server` process survives, `rm -rf apps/web/.next`, restart.
  Typecheck and test are safe to run against a live dev server; only `build` is not
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
  members who opted their passport public. Age is NOT a condition — migration
  0020 withdrew the minors exclusion (operator decision 2026-07-25, minors are
  treated as adults). Every ranking joins that view instead of `users`, so a
  new slice inherits the consent rule
- Campaigns (Stage 5.3) are ROWS, but their scoring is a validated `rules` JSONB
  document (`lib/src/campaigns`) compiled to SQL in `db/src/campaigns.ts` —
  creating a campaign is a form, inventing a new kind of scoring is a grammar
  change. Windows are civil Sofia dates, `ends_on` inclusive. Scoring counts
  EVERYONE; only display is gated, so an unpublished member can win a
  prize without appearing on a public individual board. Closing freezes the
  standings into `campaign_results`, which deliberately stores no display name —
  the placing is frozen, the identity resolves live
- Session mail (Stage 4.2) is sent ONLY from the worker. The web app enqueues
  `session.notify` with occurrence ids and ACCOUNT ids — never an address, since
  a job row outlives the account it names — and the worker resolves the inbox at
  send time. Idempotency is `play_session_notifications`, whose TWO partial keys
  matter: the RSVP-scoped kinds key on the arrival ticket (`rsvp_seq`) so a
  member who re-joined after withdrawing can be confirmed and promoted again,
  while reminders and cancellations key on NULL. Promotion has no event to hook
  (4.1 promotes by arithmetic), so `withdraw` diffs who was going either side of
  the update; concurrent withdrawals may overlap and that is fine, because the
  ledger dedupes the send
- Attendance scoring (Stage 5.4): only a `qr` check-in may score, and that is a
  CHECK (`play_session_checkins_only_qr_scores`), not application code. The
  browser's coordinates live for one statement and only `distance_m` is stored —
  never a latitude or longitude. Nothing in the anti-abuse layer REFUSES a
  check-in; attendance is always recorded and only the payment stops
- Open data (Stage 6.1) is a CATALOGUE, not endpoints: `lib/src/opendata/schema.ts`
  declares every dataset and every field, and the API, the nightly dumps, the
  `/danni` docs page and the PII denylist all read that one array. A column
  cannot leave the building without being declared, documented and scanned —
  the SELECT list is GENERATED from the fields, so `SELECT *` is
  unconstructible. Guards, weakest to strongest: a person-bearing token
  denylist on names and on SQL, an ALLOWLIST of readable relations (the strong
  one — it catches tables that do not exist yet), no `jsonb` field ever
  (`facilities.attrs` is OSM tags, which include `contact:phone`), and a
  live-DB test that the returned columns are exactly the declared ones. The
  facility export carries the public map's own visibility predicate
  (`PUBLIC_FACILITY_PREDICATE` → `publicFacilityVisible`), so a download can
  never contain a row the site would not show. API keys raise the rate limit
  and never gate access; `api_keys.key_hash` is CHECK-pinned to 64 hex chars,
  so the column cannot hold a key. There is deliberately NO request log. Dumps
  are versioned by civil Sofia date in the path, stamped with the VERSION
  rather than the wall clock (so a re-run is byte-identical and the `immutable`
  cache header is honest), and the `opendata_dumps` row is written only after
  the file is hashed
- Municipal CSV inbox (Stage 6.3, `/admin/obshtini`, `requireRole('admin')`) is
  the first writer to sit in the MIDDLE of the merge policy — it overwrites
  osm-set fields and is frozen by crowd-set ones, so a registry can correct
  stale map data but never clobber a resident's on-the-ground fix. No migration:
  `source='municipal'`, the sources row and jsonb `attrs` already exist. Pure
  core in `lib/src/import-municipal` (row normalize + `classify` new/match/
  conflict); DB core in `db/src/import/municipal.ts` (PostGIS distance dedupe +
  `mergeFields` + `facility_edits` writes, takes a `pg` client like the OSM
  importer); thin web adapter in `apps/web/lib/import/municipal.ts`. Dedupe is
  distance+name, biased so a false CONFLICT (human reviews) beats a false MATCH
  (silent wrong rewrite): auto-match only ≤40 m with a matching name, everything
  ambiguous is a conflict the operator resolves per-row (skip/link/new),
  re-validated at commit — the posted preview is never an authorization. New
  rows insert `source='municipal'`, `needs_verification`, municipality derived
  by `ST_Contains`, provenance in `attrs.municipal`; `actor=NULL` (institutional,
  like OSM); an updated OSM-origin row keeps `facilities.source='osm'` (row
  origin; per-field provenance lives in `facility_edits.source`). Re-importing an
  unchanged registry writes nothing (mergeFields → unchanged). The policy tests
  in `lib/src/merge-policy.test.ts` were EXTENDED with the municipal-in-the-middle
  scenarios
- Reports (Stage 6.2) are a CATALOGUE like open data: `lib/src/reports/`
  declares each figure as a Bulgarian label, a definition, a unit, an SQL query
  and two flags (`additive`, `personDerived`), and the admin annex, the PDF
  script, the printed methodology and the reconciliation tests all read it. The
  methodology section prints each figure's SQL verbatim — a figure is traceable
  by design. Three rules are structural: attendance is reported by check-in
  METHOD (never summed, because 0014's CHECK says only `qr` is evidence);
  distinct-person metrics are `additive: false` and the reconciliation test
  proves additive ones sum across municipalities to the national figure while
  non-additive ones do not; suppression is a property of the REPORT (public
  quarterly suppresses person-derived counts below 5, the ММС annex does not,
  zero is never suppressed, a missing figure is an em dash not 0). Bulgarian
  field names live in the catalogue, NOT in `messages/*.json`: an annex is a
  ministry-specified document format that must read identically in any UI
  locale, and keeping it out of i18n leaves the hardcoded-Cyrillic gate's
  allowlist empty. Reporting periods are civil Sofia, half-open, resolved
  through the recurrence engine — the renderer prints the inclusive last day.
  Coverage figures EQUAL `mv_national_stats` (same reconciliation standard as
  /statistika). No server-side PDF (Chromium in the prod image is too heavy for
  the VPS); `scripts/quarterly-report` renders HTML→PDF via Playwright, the
  admin screen serves print-ready HTML. `getPool()` in `@sportkarta/db` exists
  for the report runner's positional-parameter binding
- Monetisation (Stage 8, `docs/MONETISATION.md`) is CONTENT BESIDE our own —
  never surveillance, never authority. One registry (`partners`, 0019) carries
  every commercial actor including advertisers (`tier='advertiser'`, 0021); the
  three placement surfaces reference it and never copy its columns, so hiding a
  partner withdraws their logo everywhere at once. The rendering rule is written
  ONCE as `PARTNER_RENDERABLE` in `apps/web/lib/partners.ts` (visible AND window
  active) and every reader embeds it — `/partnyori`, the headline strip, the
  campaign sponsor line (`campaigns.partner_id`, 0022), the facility adoption
  (`facility_sponsorships`, 0023) and the ad slots (`ad_placements`, 0021).
  Ad slots are the compliance-critical part: four slot keys closed in three
  agreeing places, selection by SURFACE only (`AdSlot` receives no viewer
  attribute, which is why the site still needs no consent banner), an unsold
  slot renders nothing, the «Реклама» label is inseparable from the creative,
  and there is deliberately NO impression or click counter anywhere. Slot
  exclusivity and one-adoption-per-facility are EXCLUDE constraints (btree_gist),
  not application checks. Every table here is off the open-data
  `ALLOWED_RELATIONS` and none has a contact-person column — sponsor contacts
  are natural persons and live in the offline CRM. Adoption is an ADJACENT table:
  sponsorship never touches a `facilities` row, so it stays outside the merge
  policy and `facility_edits`. Creatives and logos stream from row-decides routes
  that repeat the visibility predicate. `PARTNER_STRIP_ENABLED` ships off
- i18n keys must be NESTED, never dotted: next-intl reads `.` as nesting and
  rejects the catalogue at request time, and the parity test cannot see it
  (`apps/web/tests/i18n.test.ts` has a separate guard)
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
- Public individual exposure (a public passport, a named leaderboard row, a
  named campaign standing) requires the member's OWN opt-in, enforced at the
  QUERY layer by the `leaderboard_eligible_members` view — never by a UI check.
  That view must never be widened; adding a board means a new query against it.
  Age is not a condition: migration `0020_minors_as_adults` withdrew the
  minors exclusion (operator decision 2026-07-25 — minors are treated as
  adults). `is_minor` is still derived from a DOB that is still discarded, and
  gates NOTHING; do not reintroduce a predicate on it without an operator
  decision reversing 0020
- Migrations forward-only, reviewed by db-migration-reviewer subagent
- Deploys happen ONLY via GitHub Actions on main — never deploy from a session
- Secrets: real values live only in `.env` (gitignored), GitHub Actions
  secrets, and the VPS; `.env.example` documents every variable with dummy values
