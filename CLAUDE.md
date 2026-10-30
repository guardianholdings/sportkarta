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
- «Клубове» (Stage 9, `docs/ROADMAP.md` 9b, `docs/MONETISATION.md` S7) is a
  paid add-on behind `CLUBS_ENABLED` (ships off; every club route 404s). The
  club is the CONTROLLER of its member records, POPS the processor. Tenancy is
  in the schema: every table carries `club_id` with composite FKs. Authority
  is in the STATEMENT (`apps/web/lib/clubs/scope.ts` — `clubScope`,
  `clubWriteScope`, `memberSelfScope`), and `apps/web/tests/club-scope.test.ts`
  refuses a write in `lib/clubs` without a scope fragment or an allowlisted
  reason; trainer rosters, portal class lists, the kiosk counter and staff
  digests are pinned to counts/names-only by `club-projections.test.ts`.
  Online payments (v2 wave E, `0046`, behind `CLUB_PAYMENTS_ENABLED`) go
  through EACH CLUB'S OWN Stripe account (Connect Standard) on Stripe's
  hosted page by redirect — no Stripe script or SDK, the NGO never holds
  funds. The webhook verifies its own HMAC and records ids only; the WORKER
  re-fetches every object as the connected account and applies a checkout
  once (`UPDATE … WHERE status='open'`); money that no longer fits is
  `unapplied`, never forced into the books. `PAYMENT_PROVIDER=fake` is a dev
  stand-in that cannot resolve in production. Fee rules and plan terms are
  SNAPSHOTTED onto bookings and memberships (`0047`) — never read live from
  the class or plan. A scope fragment's alias must be declared by its
  statement (`club-scope.test.ts`). Courts, rooms and appointments (wave C,
  `0048`): every busy interval — class occurrences in a room, reservations
  (with their buffer), closures, trainer leave — is a row in
  `club_calendar_claims`, written ONLY by triggers (a guard refuses any other
  writer) and refused on overlap by EXCLUDE constraints; a pool resource is
  counted by units under `FOR NO KEY UPDATE`. Availability is recomputed on the
  server before every booking, never taken from a form. Shop and offers (wave
  B1, `0049`): a till sale is ONE transaction — gapless number, snapshot lines,
  stock out, one `product` charge, payment or account, the offer's use — and
  is reversed, never edited (and its charge is never voided on its own). Keys
  inside a club are NO ACTION, which a purge survives only because every
  table has its OWN `club_id → clubs` CASCADE — a child reached solely
  through another table is checked before it is gone and refuses the purge
  (why `club_sale_lines` carries one). Offers are decided by the pure engine
  inside the purchase's transaction (`resolveOffer`, which locks a capped
  offer); a use is DERIVED (a reversed sale or a mistaken membership frees
  it) and an OPEN online checkout carrying an offer counts as one (a
  reservation, with a 31-minute session), so a voucher cannot be spent twice.
  Tills and desks show the post-offer total via `previewOffer`. Wallet and
  invoices (wave B2, `0050`): credit is DERIVED from the books
  (`club_wallet_balances`: wallet-charge payments minus `wallet`-method
  payments), and `club_payments_wallet` is the only arbiter — every row the
  club writes keeps it ≥ 0, while a refund the provider reports is a fact and
  may take it below (what the client owes). Revenue sums exclude
  `method = 'wallet'`. Credit is INVOICED WHEN LOADED (the operator's
  accountant, 2026-10-25): a top-up is invoiced for what stays on it,
  `club_invoices_wallet_spent` refuses an invoice for a charge credit was
  spent on, and `club_payments_wallet_invoiced` refuses credit on a charge
  with a live invoice — so no euro is declared twice; spent credit never
  leaves as money (`club_payments_wallet_cash_back`), and a pay-out of
  invoiced credit writes a partial credit note for what leaves
  (`creditInvoice`). An invoice's number, chronology, lines-add-up and
  one-live-per-charge are triggers (deferred where they must see the whole
  transaction), and `club_number_sequences_used` refuses a number drawn
  without its document. The invoice document's words live in
  `lib/src/clubs/invoice-document.ts` (Bulgarian in any locale, like the
  ministry annex), allowlisted in the package Cyrillic gate. Messaging (wave F1, `0051`):
  e-mail, SMS and push are sent ONLY by the worker, each channel its own
  claim in `club_notifications`, unique per (club, channel, key); a club's
  SMS parts per Sofia month are capped by a trigger (`club_notifications_sms_cap`,
  operator-set `clubs.sms_monthly_cap`); a push endpoint must match the
  known-push-service CHECK (the SSRF guard) and the VAPID key is derived from
  `PUSH_VAPID_SECRET`, never stored. Who a group is lives ONCE in
  `db/src/clubs/audience.ts` (the members list and broadcasts share it); who
  may receive by which channel is `memberChannels` + `channelAllowed`
  (`db/src/clubs/messaging.ts`): offers need the receiving record's consent
  timestamp for that channel, never go by push, and always carry a way out.
  Bulk e-mail (`CLUB_BULK_MAIL_DAILY_LIMIT`) is SHARED, never first-come:
  broadcasts take at most `BROADCAST_SHARE_OF_BULK` of the day, a capped
  number per club per sweep, least-sent club first; automations split the
  rest in equal per-club parts, then hand on the leftover. The allowance is
  spent only after a claim succeeds, so somebody already reached never costs
  a token. Inbox, prospects and ratings (wave F2, `0052`): a thread is
  between the club and ONE client record, written only by signed-in people;
  a public inquiry first gets the person their own record (`ensureSelfRecord`,
  the trial path). Notices are enqueued after the commit and only when the
  other side had read up to then, and never carry what was written. The lead
  STAGE is derived (`club_lead_stages`), never stored; the desk stores only
  what a person decides. `club_feedback_attended` admits only somebody who
  came and records the trainer itself; the public average needs
  PUBLIC_RATING_MIN_COUNT ratings of classes the member SCANNED into (QR or
  card), and the club's Google link follows EVERY rating (review gating is
  forbidden). A minor's record has no conversation; an NGO admin reads the
  inbox and never writes as the club. The request to rate is marketing
  (consent) until a lawyer says otherwise. Events (wave D1, `0053`): SEATS are
  the database's — `club_event_registrations_seat` counts under the event row
  lock, refuses a newcomer while somebody waits for that ticket, and a
  capacity never drops below the seats taken; a freed seat goes to the line in
  the SAME transaction (`promoteEventWaitlist`), as a hold-to-pay offer when
  the event takes payment online only. Every place-writer locks the event
  first, then checkouts → charges → registrations; a payment never takes the
  event lock. One charge per place; a published event's court closure is its
  trigger's alone (`club_time_blocks_event_guard`). Tournaments (wave D2,
  `0054`) are events of kind `tournament`: the draw and the Elo are pure in
  `lib/src/clubs/tournament.ts`, matches are rows, and standings and ratings
  are DERIVED on every read, never stored. Once drawn, the entrants are the
  places the draw names, numbered by seed (`drawnSeeds`). A public result names
  an entrant only with their own `name_public_at`, decided IN THE PUBLIC
  STATEMENT, and only for a confirmed place whose client still has a live
  link; the registrations guard clears it when the place ends or the client
  is erased, `club_member_links_clear_names` when the link goes, and a consent
  can always be withdrawn (`setNamePublic` off needs no live place and no
  writable club). A recorded result is never deleted or withdrawn
  (`club_tournament_matches_guard`, purge excepted). Documents (wave G1,
  `0055`): a document's title and text are append-only versions numbered and
  hashed by the database (sha256 over the raw sha256 digests of the title and
  body in both languages); a signature names its version, only the latest of
  a live document, once per client. A minor signs their own record like
  anyone (operator decision 2026-10-30, in line with 0020); a guardian may
  sign only a minor's (`club_document_signatures_guardian_minor`). In the
  portal the signer kind follows the LINK that signs, never the form; at the
  desk the witness records it. Who is missing what is the view
  `club_documents_missing`; a missing signature WARNS and never refuses.
  Ranks (wave G2, `0056`): a client's CURRENT rank is their newest award not
  revoked (by day, then by when it was recorded), never the highest place;
  readiness for the next one is the view `club_member_rank_progress`
  (check-ins since that day, in the ladder's sport) and never refuses an
  award. An award is append-only — a mistake is revoked once — and only the
  club's own staff grade (`clubStaffWriteScope`, no NGO admin). Belt colours
  are a closed palette of `--belt-*` tokens. A trainer reads the ladder pages
  through the projection in `ranks.ts` (`progressRows`, a name and counts).
  Integrations (wave H1, `0057`, `CLUB_API_ENABLED` ships off): a club API
  key (`skbk_`, SHA-256 only) ACTS AS ITS CREATOR — `verifyClubApiKey` returns
  a `ClubActor` for that staff member with their role as of now (and
  `apiKeyId`, which the audit log records as actor kind 'api'), so the API,
  the MCP connector and the office run the SAME scoped functions; the key's
  scopes only narrow it, in code, before any statement runs. Webhooks are an
  outbox the database fills (`club_webhook_enqueue` triggers, FOR KEY SHARE so
  a removed endpoint never fails a desk write); the worker posts them, and
  every request to an address somebody typed goes through `safePost`
  (`@sportkarta/lib/net`: https, public addresses checked in the socket's own
  lookup, no redirects) — never a bare fetch. Webhook secrets are derived
  from `CLUB_WEBHOOK_SECRET`, never stored. A door is a `club_kiosk_devices`
  row of kind 'door' whose secret has a kiosk cookie's shape, so EVERY device
  lookup names its kind; a door is the one check-in that may say no (the
  club's rule), and a refused door records nothing.
  Form-error lookups go through `formErrorText` (own keys only): the
  `ClubFormMessages` catalogue must stay a PLAIN object, because it crosses
  into client components. Writes need `clubWritableSql` (active and paid or
  community, 14-day grace); every public surface embeds `clubRenderableSql`.
  Check-ins never refuse (`covered=false` is recorded); only a QR/card visit of
  a consenting linked member writes `training_logs(source='club',
evidence='qr_verified')`, enforced by trigger + CHECK, never points.
  Invitation tokens are MINTED BY THE WORKER at send time (the web stores a
  placeholder digest). Club mail: linked members at their POPS address,
  unlinked records only when the club opts in and never after a one-click
  opt-out, minors never (the guardian or nobody). Migration 0038 holds the
  enum ADD VALUEs alone and later CHECKs compare `::text`, because the
  migrator runs every pending file in one transaction
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
