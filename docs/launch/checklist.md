# Launch gate — SportKarta (Играй Навън)

Measured launch-readiness gate. Every value below is a real measurement from a
production build; nothing is estimated. Re-run before the public launch.

- **Date:** 2026-07-22
- **Commit:** `feat(launch): PWA + launch gate` (Stage 2)
- **Dataset:** 6 587 facilities (seed), materialized views populated.

## Methodology

| Check          | Harness                                                                                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lighthouse     | v13.4.1, **mobile** (default Moto-G4 + 4× CPU throttle), system Google Chrome headless, against the **production** build (`next build` + `next start`, `NODE_ENV=production`) on `http://localhost:3000`.                                                       |
| E2E            | Playwright (Chromium) against the **dev** server — the admin flow's test-only token is deliberately rejected under `NODE_ENV=production` (`lib/admin-auth.ts`) and the session cookie is `Secure` (HTTPS-only), so functional e2e runs against dev, as CI does. |
| Reconciliation | `@sportkarta/db` vitest against the running Postgres/PostGIS; each public statistic is proven equal to a direct `facilities` query.                                                                                                                             |
| i18n gate      | `@sportkarta/web` vitest — bg/en key parity + hardcoded-Cyrillic detector across `app/`, `components/`, `lib/`.                                                                                                                                                 |
| Sitemap        | Fetched from the running server; well-formedness via `xmllint`, URLs spot-resolved.                                                                                                                                                                             |

## Results

### 1. Lighthouse mobile ≥ 90 — ❌ FAIL (Performance)

| Page                       | Performance | Accessibility | Best-practices | SEO    |
| -------------------------- | ----------- | ------------- | -------------- | ------ |
| `/` (map home)             | **73** ❌   | 100 ✅        | 96 ✅          | 100 ✅ |
| `/obekt/{slug}` (facility) | **72** ❌   | 100 ✅        | 96 ✅          | 100 ✅ |

Core Web Vitals are **good**; the miss is entirely main-thread blocking:

| Metric                   | `/`          | facility     | Note            |
| ------------------------ | ------------ | ------------ | --------------- |
| First Contentful Paint   | 0.9 s        | 0.8 s        | good            |
| Largest Contentful Paint | 1.8 s        | 1.7 s        | good            |
| Cumulative Layout Shift  | 0            | 0            | perfect         |
| Speed Index              | 1.3 s        | 0.8 s        | good            |
| **Total Blocking Time**  | **1 640 ms** | **1 850 ms** | **the blocker** |
| Time to Interactive      | 7.1 s        | 5.4 s        | driven by TBT   |

**Root cause (single, precise):** one 267 KB JS chunk — **MapLibre GL JS** — costs
~1.6–1.9 s of main-thread script evaluation. It is already code-split
(`next/dynamic({ ssr:false })` in `map-explorer`, `place-map`, `mini-map-loader`),
but `ssr:false` still mounts it immediately on the client, so its parse+execute
lands inside the Lighthouse trace window and dominates TBT. This is the known
Lighthouse-mobile ceiling for interactive-map apps. The facility page inherits
the same cost from its below-the-fold mini-map.

**Remediation options (not yet applied):**

1. **Lazy-mount below-the-fold maps** (facility mini-map, `igrishta` scoped map)
   behind an `IntersectionObserver` — no UX change, should lift those pages to
   ≥ 90.
2. **Home map:** it is the primary above-the-fold content, so reaching ≥ 90
   there requires a UX change (static preview + "tap to load the interactive
   map"). Trade-off decision — see the open question below.
3. **Accept the score** for the map-first pages: real-world UX is fast
   (FCP 0.9 s, LCP 1.8 s, map usable ~2 s, zero layout shift). The ≥ 90 mobile
   target may be unrealistic for a full MapLibre canvas.

### 2. Playwright e2e — ✅ PASS (7/7)

health, home map renders in bg, admin authz (unauth redirect ×2, wrong-token
rejected), public map "find nearest free football pitch" → bottom sheet →
facility page, and the admin V-keystroke verify + audit-row flow. All green.

### 3. Statistics reconciliation — ✅ PASS (6/6; db suite 12/12)

Every `/statistika` + `/api/stats` number equals a direct `facilities` query
(national totals, per-municipality, per-sport, access %, lighting %). `/api/stats`
`national.total` = **6 587** = live DB count.

### 4. i18n gate — ✅ PASS (web suite 56/56)

bg/en key parity holds; no hardcoded Cyrillic UI strings outside `messages/*.json`
(the PWA manifest sources its bg strings from `messages/bg.json`).

### 5. Sitemap validity — ✅ PASS

`/sitemap.xml` is a well-formed `<sitemapindex>` → `facilities.xml` (6 587 URLs),
`places.xml`, `static.xml`; all well-formed (`xmllint`). Spot-checked URLs resolve
200 (including the 7 numeric slugs from facilities literally named "№1", "11",
etc.). `robots.txt` allows `/`, disallows `/admin`, `/en/admin`, `/api/`, and
points at the sitemap.

### 6. PWA — ✅ PASS

`/manifest.webmanifest` valid (standalone, bg, theme `#0f766e`, 3 icons incl.
maskable); `<head>` carries the manifest link + theme-color; `/sw.js`,
`/offline.html`, and all icons serve 200. Service worker: precache offline
shell, network-first navigations with offline fallback, cache-first static,
stale-while-revalidate tile cache (64-entry LRU, 206→synthetic-200 so the Cache
API accepts pmtiles range responses). Registered in production only.

### 7. Privacy — ✅ PASS

bg + en, plain language: what we store, cookieless Umami, transient-IP-only
rate-limiting, EXIF-stripped moderated photos, ODbL/Protomaps attribution, and a
Contact section (uses `CONTACT_EMAIL` when set, else points to the per-facility
report form — verified fallback with no email configured).

### 8. Analytics & error monitoring — ✅ PASS (opt-in)

Umami (`UMAMI_SRC` + `UMAMI_WEBSITE_ID`) and GlitchTip (`GLITCHTIP_DSN`) are
env-gated, **disabled by default** (empty in `compose.prod.yml`), read at runtime
so they apply without a rebuild. `@sentry/browser` loads lazily only when a DSN
is set.

## Go / No-Go

> The **Lighthouse mobile ≥ 90** criterion **fails** on both public pages
> (Performance **73** / **72**) — this stays recorded as a failed criterion, not
> softened into a pass.
>
> **Every other criterion is GO:** e2e, statistics accuracy, i18n, sitemap, PWA,
> privacy, and env-gated analytics all pass, and Accessibility / Best-practices /
> SEO are 100 / 96 / 100.

**Operator decision (2026-07-22): GO, with a Performance exception.** The single
blocker is MapLibre's main-thread cost — an inherent trait of a full interactive
map canvas, on pages whose real-world UX is fast (FCP 0.9 s, LCP 1.8 s, CLS 0).
The operator has reviewed the number and accepted it for launch. The ≥ 90 gate
remains formally failed; lazy-mounting the below-the-fold maps (the facility
mini-map and the `igrishta` scoped map) behind an `IntersectionObserver` is
tracked as a no-UX-cost follow-up that should lift those pages, with the home
map's above-the-fold cost a separate, later UX call.

The public launch itself is still gated by the manual DNS cutover (see the
session's MANUAL STEPS), so launch timing remains a deliberate operator action.

## Deploy pipeline

The GitHub Actions **Deploy** workflow had been failing on every push, so
production was not receiving updates. Two independent causes, both fixed:

1. **web image** — `Dockerfile` `COPY … /app/apps/web/public` failed because
   `apps/web/public/` did not exist in the repo. Fixed by the PWA change (the SW,
   offline page, and icons created that directory).
2. **worker image build** — `apk add --no-cache osmium-tool` failed:
   `node:24-alpine` now tracks Alpine 3.24, which dropped `osmium-tool` (only
   `libosmium` remains). Fixed by moving the `worker` stage to a Debian base
   (`node:24-bookworm-slim` + `apt-get install osmium-tool`); the worker's
   runtime deps are pure JS, so the musl→glibc move is safe.
3. **worker runtime crash** (found during verification; pre-existing, unrelated
   to the base change) — the container crash-looped because `@sportkarta/db`
   ships as un-built TS (`exports: "./src/index.ts"`) whose `.js` import
   specifiers plain `node` can't resolve. Fixed by launching the worker through
   `tsx` (already in the image), matching how the rest of the monorepo consumes
   TS workspace source.

Verified locally end-to-end: `docker build --target worker` builds; running the
image against the dev DB, the worker connects to pg-boss, runs `stats.refresh`,
and processes an `import.osm` **dry-run** that exercises `osmium` on the real
Bulgaria extract (265 boundary relations matched, transaction rolled back).

Deploy/worker follow-ups (tracked, not blocking this launch):

- **OSM import cache dir** — ✅ fixed. The import/audit download cache now
  defaults to `os.tmpdir()/sportkarta-osm-cache` (world-writable, so the `node`
  user can write it) via a shared `resolveCacheDir` helper, overridable with
  `OSM_CACHE_DIR`; `var/` is now dockerignored so the extract is no longer baked
  into images. Verified end-to-end: a real ~90 MB download + osmium + dry-run
  import ran as uid 1000 in the worker image.
- **web `/data/uploads` uploads** — same root cause, still open: the volume is
  root-owned while `web` runs as `node`, so public report-photo uploads would
  `EACCES` in prod. Needs a node-writable persistent volume (can't use tmpdir).
  Tracked separately.
- **Image pinning/size** — the base tags float (`node:24-alpine`,
  `node:24-bookworm-slim`) and `osmium-tool` is unversioned; the worker copies
  the whole monorepo. Reproducibility (digest/version pins) and a pruned worker
  copy are worthwhile later passes.

## Follow-ups (non-blocking, from code review)

Applied in this change: SW now caches only 206 range responses (no full-archive
buffering), guards the cache write against storage-quota errors, and is genuinely
stale-while-revalidate; `app/apple-icon.png` wired via Next's file convention.

Deferred, tracked here:

1. **Analytics on `/admin/**`.** The shared `[locale]` layout renders Umami +
   ErrorMonitor on admin pages too, so (when enabled) moderator navigation and
   facility IDs reach the self-hosted analytics. Low severity (self-hosted,
   disabled by default); gate analytics/monitoring off the admin subtree.
2. **GlitchTip breadcrumbs.** If error monitoring is turned on, default
   breadcrumbs (fetch URLs, clicked text) still reach GlitchTip — add a
   `beforeSend`/breadcrumb scrub and disclose monitoring on the privacy page.
3. **SW cache versioning.** `VERSION` is hardcoded `v1` and `STATIC_CACHE` is
   unbounded (content-hashed, so correct but accumulating). Tie `VERSION` to the
   build id and bound the static cache on a future pass.
4. **Tests.** The pure SW helpers (`tileKey`, `trim`, synthetic-200) and the
   `CONTACT_EMAIL` fallback branch are untested; add coverage when the SW is
   refactored into importable helpers.
5. **ISR analytics latency.** `igrishta` pages (`revalidate=3600`) capture the
   analytics env at render, so toggling `UMAMI_*`/`GLITCHTIP_DSN` reflects there
   within the revalidation window rather than instantly.
