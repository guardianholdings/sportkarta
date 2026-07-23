# SportKarta / Играй Навън — Development Plan v2 (Self-Hosted, Claude Code Desktop App)

Supersedes v1. Changes: **self-hosted stack** (no managed platform dependencies), **GitHub-driven deployment**, workflow adapted to **Claude Code in the Claude desktop app on macOS** (no terminal use by the operator — Claude Code executes all shell work inside sessions).

This file must live in the repo as `docs/ROADMAP.md`. Every Claude Code session reads it.

**Assumptions:** one operator driving Claude Code ~15–20 h/week from the desktop app; one Linux VPS (EU); NGO budget (~€15–25/mo infra); Bulgarian-first product; Sofia + Plovdiv + Varna at launch. Timeline unchanged: ~26 weeks full platform, public map MVP week 6.

---

## 0. Fixed technical decisions (v2)

| Layer | Choice | Why / tradeoff |
|---|---|---|
| App framework | Next.js (App Router) + TypeScript, `output: "standalone"` | SSR for programmatic SEO; standalone output = clean Docker image |
| Database | PostgreSQL 16 + **PostGIS**, self-hosted in Docker | Geospatial is the core domain. You own the data end-to-end |
| ORM | Drizzle + raw SQL for geo | Unchanged from v1 |
| Auth | **better-auth** (self-hosted): email OTP + optional Google OAuth | No auth vendor; schema lives in your Postgres. Google login is optional and can be disabled for zero external identity deps |
| File storage | Local Docker volume + `sharp` processing, storage adapter interface | No S3 vendor. Adapter keeps a later MinIO/S3 move trivial |
| Jobs/queue | **pg-boss** (Postgres-backed) + worker process in compose | Reminders, digests, imports — no Redis, one database to operate |
| Map tiles | **Protomaps** `.pmtiles` (Bulgaria extract), self-served + MapLibre GL | Fully self-hosted vector basemap — zero tile-service dependency, fast, tiny ops cost |
| Email | SMTP via env (commodity protocol, provider-agnostic) | See "external surface" below — deliverability is the one place pure self-hosting punishes you |
| Analytics | **Umami** self-hosted (compose service) | Cookieless, GDPR-clean |
| Errors | **GlitchTip** self-hosted (Sentry-compatible SDKs) | Lightweight alternative to self-hosted Sentry |
| Reverse proxy / TLS | **Caddy** in compose | Automatic Let's Encrypt, dead-simple config |
| Hosting | One Linux VPS (e.g., Hetzner CX/CAX, EU) running Docker Compose | Full control, EU data residency (a real asset in ММС conversations) |
| Deployment | **GitHub Actions → build image → GHCR → SSH deploy step → `docker compose up -d`** on the VPS | Push to `main` = deploy. All server operations run from CI, never from the operator's terminal |
| CI | GitHub Actions: typecheck, lint, unit, Playwright vs preview compose | Unchanged in spirit |
| Local dev | Docker Desktop (or OrbStack) on the Mac; Claude Code runs everything via compose | One-time GUI install by the operator; after that Claude Code drives it |
| Repo/GitHub auth | **GitHub Desktop** app for one-time sign-in + publish | Populates macOS keychain git credentials so Claude Code's `git push` works with no terminal auth dance and no tokens pasted into sessions |
| Mobile | PWA first; native only on Stage 7 evidence | Unchanged |

**Honest external-surface statement (decide once, eyes open).** "No external services" in absolute terms is impossible; here is the residual surface: GitHub (repo + CI — you asked for it), the VPS provider (rented hardware, not a SaaS lock-in; migrate with `docker compose` + backups in an afternoon), Anthropic (Claude Code itself), an SMTP relay for transactional email (swappable commodity; a fully self-hosted mail server is possible but IP-reputation/deliverability pain for OTP codes is real — revisit post-launch if you insist), and optionally Google (only if Google login stays enabled). Everything else — DB, auth, storage, tiles, analytics, errors, jobs — runs on your box.

**Legal constants (unchanged from v1, still binding):** ODbL attribution for OSM-derived data everywhere; open publication of the combined dataset; GDPR/ЗЗЛД: minors never on individual public leaderboards, DOB derived-then-discarded, no PII in logs/exports, photos of facilities not people, cookieless analytics. Municipality accountability = data + methodology, provenance on every record. Self-hosting on an EU VPS strengthens the data-sovereignty story — use it in ministry conversations.

---

## 1. Claude Code operating model (desktop app)

**Where work happens.** All development runs inside Claude Code sessions in the desktop app's Code tab, pointed at the local repo folder. The operator never opens Terminal: git, docker, pnpm, migrations — Claude Code executes them via its own shell inside the session. Manual operator actions are limited to GUI apps (Finder, GitHub Desktop, Docker Desktop, browser dashboards) and are listed explicitly at the end of any session that needs them.

**Sessions.** One prompt = one session. Start a **new session** per prompt (the app equivalent of `/clear`). Set the session model to **Fable 5** for architecture, geospatial logic, and security-sensitive work; a faster model is acceptable for mechanical batch work (translations, boilerplate). Every build prompt enforces *plan first → operator approves → implement*; if the app's plan mode toggle is available, use it, but the textual contract in each prompt is the binding mechanism.

**Project config is file-based and identical to terminal Claude Code** — CLAUDE.md, `.claude/settings.json` (permissions), `.claude/hooks`, `.claude/agents/*` all live in the repo and work the same in the app. Session 0.2 creates them.

**CLAUDE.md skeleton (Session 0.1 creates, every stage-close updates):**
```markdown
# SportKarta
NGO platform: national map of free public sports facilities in Bulgaria
+ pickup sessions + gamified sports passport. Bulgarian-first (bg default).
Self-hosted stack. Operator works ONLY through Claude Code desktop app —
never instruct them to run terminal commands; run them yourself, and put
GUI-only steps (Finder, GitHub Desktop, browser) in a MANUAL STEPS list.

## Commands (run them yourself)
- pnpm dev / build / lint / typecheck / test / test:e2e
- docker compose -f compose.dev.yml up -d   (local Postgres+PostGIS, Umami, GlitchTip)
- pnpm db:migrate / db:seed / import:osm

## Architecture
- Next.js App Router standalone; server components default
- Drizzle schema in /db/schema; geospatial = raw SQL in /db/geo
- EPSG:4326 everywhere; geometry(Point,4326); GIST indexes mandatory
- better-auth for auth; pg-boss for jobs (worker in /apps/worker)
- Storage adapter interface in /lib/storage (local-volume impl)
- Tiles: self-served pmtiles at /tiles; MapLibre style in /apps/web/map
- i18n: next-intl; NEVER hardcode UI strings; bg source of truth

## Rules
- Provenance on every facility record; crowd-verified fields never
  overwritten by imports (merge policy: crowd > municipal > osm)
- OSM/Protomaps attribution on every map view and export
- No PII in logs; no identifiable people in photos
- Minors: no individual public leaderboards
- Migrations forward-only, reviewed by db-migration-reviewer subagent
- Deploys happen ONLY via GitHub Actions on main — never deploy from a session
```

**Permissions (`.claude/settings.json`).** Allow without prompting: pnpm lint/typecheck/test/build, git status/diff/log/add/commit/push, docker compose against `compose.dev.yml`. Require approval: migrations against non-local DATABASE_URL, `docker` against prod compose file, `rm -rf`, reading `.env*`. Prod credentials exist only as GitHub Actions secrets and on the VPS — never inside sessions.

**Hooks.** PostToolUse (Edit/Write on `*.ts,*.tsx`) → typecheck + lint --fix. Pre-commit → unit tests on changed packages. SessionStart → print branch + first unchecked ROADMAP item.

**Subagents.** Same four as v1: `code-reviewer` (adversarial: authz, PII, SRID/GIST correctness, i18n misses), `db-migration-reviewer`, `osm-data-auditor`, `test-writer`.

**Automation without a terminal.** Anything v1 ran headless (`claude -p`) becomes either (a) a scheduled GitHub Actions workflow, or (b) a recurring paste-prompt run in the app (default for the weekly QA). CI is the operator's remote hands: deploys, scheduled jobs, and backup verification all run from Actions.

---

## 2. Stage 0 — Foundation (Week 0–1)

**Goal:** repo on GitHub, local dev running in Docker, CI/CD to the VPS, Claude Code operating model live — with zero operator terminal use.

Operator GUI prerequisites (one-time): install Docker Desktop (or OrbStack), install GitHub Desktop and sign in, create the empty `sportkarta` repo on github.com, create the VPS in the provider's web console using the cloud-init file Session 0.3 generates.

Sessions: 0.0 repo bootstrap (git init, docs/ROADMAP.md in place, first commit, publish via GitHub Desktop) → 0.1 scaffold + CLAUDE.md → 0.2 permissions/hooks/subagents → 0.3 compose stack + cloud-init + CI/CD pipeline.

**DoD:** push to `main` auto-deploys to the VPS over HTTPS (Caddy cert live); `compose.dev.yml` runs locally; a PostGIS `ST_DWithin` smoke query passes in both environments; hooks fire; code-reviewer reviews a test PR.

---

## 3. Stage 1 — Data foundation (Weeks 1–3)

Unchanged in substance from v1 — schema, OSM import, boundaries, admin panel — with these v2 specifics: photos go through the storage adapter to the local volume; import runs as a pg-boss job invocable from the admin UI (so re-imports never need a terminal); Geofabrik `bulgaria-latest.osm.pbf` download is cached on the VPS volume.

Tables: `facilities` (geom Point 4326, sport_types[], surface, lighting nullable, covered, access enum, status enum, municipality FK, quarter, source enum osm|municipal|crowd, osm_type+osm_id unique-partial, attrs jsonb) with GIST; `municipalities` (EKATTE, MultiPolygon); `facility_photos`; append-only `facility_edits` audit; `sources`. Merge policy as code + property tests: crowd > municipal > osm, field-level, every change audited.

**Gates:** operator approves the tag-mapping table and the dry-run import report before first live import. Audit sample mismatch <2%. National facility count sanity-checked (≥~5,000 expected; investigate the filter if far below).

---

## 4. Stage 2 — Public map MVP (Weeks 3–6) → public launch

Unchanged in substance: MapLibre map (self-served pmtiles) with clustering/filters/URL state; facility pages with transliterated stable slugs + schema.org; anonymous problem-report flow (honeypot + rate limit, EXIF-stripped photos to moderation); programmatic SEO pages `/igrishta/{city}/{quarter|sport}` with thin-content guard, sitemap, hreflang; `/statistika` + `/api/stats` with reconciliation tests and the reproducible launch press-stats report; PWA + privacy page + Umami + GlitchTip.

**Launch gate:** Lighthouse mobile ≥90 on map + facility page; Playwright flows green; stats reconcile; i18n completeness gate green; go/no-go checklist written with measured values, failures stated plainly.

---

## 5. Stage 3 — Accounts, ambassadors, condition layer (Weeks 6–9)

better-auth (email OTP + optional Google); `is_minor` derived from DOB then DOB discarded (test proves it never persists); GDPR self-service deletion with contribution anonymization. Contribution flows (add/verify/condition-report) writing through `facility_edits`; idempotent `points_ledger`. Ambassador role, municipality-scoped moderation with authz proven in tests; moderation SLA dashboard; batch pre-screen runs as a recurring in-app session prompt (assistive flags only, human decides). Municipality accountability pages + embeddable aggregate-only widget.

- [x] **3.1 Accounts, profiles, roles, erasure** — better-auth self-hosted in our Postgres (migration `0005_auth_profiles`); email OTP through the new `Mailer` abstraction (`lib/src/email`); Google behind `AUTH_GOOGLE_ENABLED`, shipped disabled. Minimal profile (display name, home city, `is_minor`); DOB derived then discarded, proven by `apps/web/tests/dob-not-persisted.test.ts`. Stage 1 `ADMIN_TOKENS` replaced by real roles (`user < ambassador < moderator < admin`, bootstrapped from `ADMIN_EMAILS`). GDPR erasure removes the profile, anonymises contributions to "бивш потребител", and leaves the append-only audit trail intact (`db/src/auth-erasure.test.ts`, `apps/web/e2e/auth-otp.spec.ts`).
- [x] **3.2 Contribution flows + points** — authenticated add (photo required, geolocated pin with manual adjust, 30 m duplicate guard, lands `needs_verification`/`source=crowd`), structured verify checklist, and condition reports (`отлично|добро|лошо|неизползваемо` + closed tag vocabulary + optional photo) — all writing through `facility_edits` with the account id as `actor` (migration `0006_contributions_points`). "It is gone" files a moderation report rather than deleting, and earns nothing. `points_ledger` is append-only and idempotency-keyed: one award per facility added, per person per facility verified, per person per facility per Sofia day for conditions, proven under concurrency and random retry interleavings in `db/src/points-ledger.test.ts`. Earning only — no spending mechanics — and no leaderboard, so the minors rule stays intact.
- [x] **3.3 Ambassadors + moderation v2** — roles collapse to `user | ambassador | admin` (`moderator` retired and CHECK-forbidden, migration `0007_ambassadors_moderation`). Ambassadors moderate photos, reports and crowd `needs_verification` facilities **only in the municipalities granted to them**, and the scope lives in the SQL: every mutation joins `ambassador_municipalities`, so an out-of-scope decision updates zero rows even with the application bypassed — proven at the query layer in `db/src/moderation-authz.test.ts`. Every decision lands in the append-only `moderation_decisions` log (opaque actor id, scope frozen at decision time, `queued_at` for SLA). Admin screen at `/admin/ambasadori` grants/revokes role and municipalities and shows per-ambassador activity; the moderation screen gains median time-to-decision, queue depth and oldest-waiting. Weekly assistive pre-screen: `docs/prompts/moderation-prescreen.md` + `pnpm mod:queue` (read-only) and `pnpm mod:flag` (writes `moderation_flags` and nothing else) — flags only, a human decides.
- [ ] 3.4 Municipality accountability pages + embeddable aggregate-only widget

---

## 6. Stage 4 — Play layer (Weeks 9–14)

Sessions schema with RRULE recurrence, rolling 8-week occurrence materialization via pg-boss, Europe/Sofia DST property tests (non-negotiable); RSVP/waitlist, tokened iCal, idempotent T-24h/T-2h reminder emails through the SMTP abstraction; organizer tools with signed expiring QR check-in; weekly city digest page + opt-in email; admin bulk-create for the сдружение's official slots; results v1 with CSV import. No timing hardware.

- [x] **4.1 Sessions schema + recurrence engine** — schema and logic only, no UI (migration `0008_play_sessions`; tables are `play_session*` because better-auth owns `sessions`). A session is scheduled in **wall clock** time: `starts_at_local` is `timestamp` without time zone and the RRULE is expanded in pure civil arithmetic (`lib/src/recurrence`), so a weekly 18:00 session is 18:00 in January and in July while the UTC instant moves. The rule grammar is a deliberate subset — `FREQ=DAILY|WEEKLY`, `INTERVAL`, `BYDAY` (weekly only), `COUNT` xor `UNTIL`, `WKST=MO` — rejected at parse time *and* by CHECK constraints, so no writer can store a rule the engine cannot expand. DST policy is explicit and recorded per occurrence in `dst_resolution`: the vanished March hour shifts forward (`gap_shifted`), the repeated October hour takes the earlier instant (`fold_first`). Property tests discover every Bulgarian transition 2020–2035 from the tz database rather than hardcoding dates (`lib/src/recurrence/dst.test.ts`), and a trigger cross-checks every materialized row against PostgreSQL's own tzdata. Occurrences are written **only** by the `session.materialize` pg-boss job over a rolling 8-week window, idempotent via `INSERT … ON CONFLICT DO NOTHING` on `(session_id, starts_at)`. RSVP stores **order only** — an arrival ticket per row, position from `row_number()`, going/waitlisted derived in `play_session_rsvp_positions` — so over-booking is impossible (no counter to race on) and a withdrawal promotes the next person with no code running (`db/src/sessions-waitlist.test.ts`). Cancelling a series cancels its *future* occurrences only; the past is never rewritten. Erasing an organiser nulls `organizer_id` and a trigger cancels the series, preserving other people's attendance — and nothing here can block a `DELETE FROM users`. Cancellation notification is stubbed to the `session.notify` queue (counts, never addresses) for 4.2.
- [ ] 4.2 RSVP notifications, tokened iCal, T-24h/T-2h reminder emails

---

## 7. Stage 5 — Спортен паспорт (Weeks 14–18)

Passport profile, declarative badge engine (config, not schema changes), DST-correct streaks; leaderboards with minor protection enforced at the query layer and attacked in tests; challenges as config with admin CRUD and a full staged demo campaign; QR/geofence-verified scoring, proportionate anti-abuse.

---

## 8. Stage 6 — Open data & institutions (Weeks 18–22)

Open data portal: documented API + nightly versioned GeoJSON/CSV dumps (ODbL + attribution), keys with soft limits, PII-denylist export tests; embeddable widget hardening; ММС-formatted grant-report exports (Bulgarian field names); quarterly national report generator with query-traceable figures; municipal CSV inbox with mapping/validation/dedupe through the merge policy.

---

## 9. Stage 7 — Hardening (Weeks 22–26)

Adversarial full-repo security review (authz, ambassador scope, minor boundary, token forgery, SSRF in importers, secrets, `pnpm audit`) → ranked findings doc, criticals/highs fixed; k6 load tests vs staging with before/after numbers on every optimization; ops runbook + **restore drill actually performed** (staging restored from latest VPS backup — nightly `pg_dump` + volume snapshots shipped off-box via restic in CI-verified jobs); GlitchTip alert rules; native-app go/no-go on PWA retention data.

---

## 10. Cadence & top risks

**Weekly:** PR reviews via code-reviewer; weekly QA session prompt; ROADMAP checkboxes. **Stage close:** CLAUDE.md update, metrics snapshot in `/docs/metrics/`, staging→prod release.

Risks, ranked, unchanged where still true: (1) ops-not-code — ambassadors and real weekly sessions gate Stages 3–4; (2) data credibility — audit gates are non-optional; (3) solo bus factor — docs discipline + grant line-item for a second dev; (4) scope creep toward booking — stay out; (5) GDPR-minors — stop-the-line rule. **New v2 risk (6): you are now your own SRE.** A managed platform's uptime/backup guarantees are gone; the compose stack, off-box backups, and the performed restore drill are the mitigation — skipping the drill converts this risk from managed to ignored.
