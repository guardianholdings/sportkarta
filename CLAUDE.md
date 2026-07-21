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
- `pnpm test:e2e` — Playwright smoke tests (apps/web/e2e)
- `pnpm db:generate` / `pnpm db:migrate` — drizzle-kit in db/
- `docker compose -f compose.dev.yml up -d` — local Postgres+PostGIS, Umami, GlitchTip (arrives Session 0.3)

## Repository layout (pnpm workspace monorepo)

- `apps/web` — Next.js App Router, TS strict, `output: "standalone"`; server components default
- `apps/worker` — pg-boss worker process (reminders, digests, imports)
- `db` — Drizzle schema in `db/schema`; geospatial = raw SQL in `db/geo`; migrations in `db/migrations`
- `lib` — shared code; storage adapter interface in `lib/src/storage` (local-volume impl; MinIO/S3 swap must stay trivial)
- `scripts` — operational scripts (OSM import etc., Stage 1+)
- `docs/ROADMAP.md` — the plan; read it at session start

## Architecture

- EPSG:4326 everywhere; `geometry(Point,4326)`; GIST indexes mandatory
- better-auth for auth (Stage 3); pg-boss for jobs (apps/worker)
- Tiles: self-served pmtiles at /tiles; MapLibre style lives in apps/web (Stage 2)
- i18n: next-intl; NEVER hardcode UI strings; `apps/web/messages/bg.json` is the
  source of truth, en mirrors it (parity enforced by `apps/web/tests/i18n.test.ts`);
  "/" deterministically serves bg — no Accept-Language negotiation

## Rules

- Provenance on every facility record; crowd-verified fields never
  overwritten by imports (merge policy: crowd > municipal > osm)
- OSM/Protomaps attribution on every map view and export
- No PII in logs; no identifiable people in photos
- Minors: no individual public leaderboards
- Migrations forward-only, reviewed by db-migration-reviewer subagent
- Deploys happen ONLY via GitHub Actions on main — never deploy from a session
- Secrets: real values live only in `.env` (gitignored), GitHub Actions
  secrets, and the VPS; `.env.example` documents every variable with dummy values
