# Function inventory — audit run 2026-07-24

**First audit run.** `docs/audit/` did not exist and has no git history, so there is no
previous inventory to diff and no verdicts to inherit. Everything below was enumerated
from the code, not from documentation.

**Baseline:** commit `00707c1` **plus the uncommitted working tree** (confirmation-dialog
policy on four admin ops, campaign-form event-kind fix, map marker positioning fix,
e2e reconciliation). The audit tests what a deploy of this tree would ship.

Legend: **anon** anyone, **user** signed-in member, **amb** ambassador (municipality-scoped),
**admin** admin, **org** session organizer, **token** capability-URL holder,
**op** operator via CLI/session, **job** pg-boss worker.

---

## A. Pages (43 under `app/[locale]`, bg default / en mirror)

### Public
| Route | What it does | Invoked how |
|---|---|---|
| `/` | Map discovery: clustered facilities, filters (sport/access/lit/surface/near-me), search, URL state (`z/lat/lng/sport/…`), result list, facility preview | nav root; tab bar *Карта* |
| `/obekt/[slug]` | Facility detail: attributes, photos, provenance, directions; hosts report/verify/condition forms | map preview → *Виж детайли*; SEO |
| `/igrishta/[city]`, `/igrishta/[city]/[segment]` | Programmatic SEO: per-city and per-quarter/sport listings, thin-content guard | sitemap/SEO; links to `/obshtina` |
| `/obshtina/[city]` | Municipality accountability: coverage per 10k, condition reports, provenance, time-to-decision | linked from `/igrishta/[city]` only (no index page) |
| `/statistika` | Public statistics from `mv_*` views | footer *Статистика* |
| `/sesii` | Upcoming public session occurrences index | tab bar *Сесии* |
| `/sesiya/[occurrenceId]` | Session page: time/place/spots, organiser (no attendees), RSVP forms, .ics download | `/sesii` list; digest/notification emails |
| `/sedmitsata/[city]` | Weekly city digest page (same query as the Monday email) | email link; **no in-app nav (BURIED)** |
| `/kampanii`, `/kampanii/[slug]`, `/kampanii/[slug]/rezultati` | Campaign list, landing (live standings), frozen results | **no nav entry since Сесии tab was fixed to `/sesii` (BURIED)** |
| `/klasirane` | Leaderboards: national/city/sport, all-time + current month | tab bar *Класации* |
| `/pasport/[handle]` | Public passport (opt-in, aggregate-only, noindex) | link shared by owner |
| `/danni`, `/danni/litsenz` | Open-data portal docs (rendered from the dataset catalogue), licence | footer *Отворени данни* |
| `/statistika`, `/privacy` | Stats, privacy policy | footer |
| `/vhod` | Email-OTP sign-in (+ Google behind `AUTH_GOOGLE_ENABLED`, ships off) | nav *Профил* when anonymous |
| `/design-system` | Token/component showcase (dev aid, indexed?) | URL only — check robots in STEP 3 |
| `/admin/login` | Legacy redirect → `/vhod?next=/admin` | old bookmarks |

### Signed-in member
| Route | What it does |
|---|---|
| `/profil` | Profile edit, digest subscription, calendar token panel, admin-panel link (role-gated), account deletion (type-to-confirm) |
| `/pasport` | Own passport: badges (derived), streaks, points; visibility toggle; implicit badge acknowledge |
| `/dobavi` | Add facility: pin, photo (required), sports chips, duplicate guard |
| `/otmetka/[token]` | QR check-in redemption (token from organiser's screen) |
| `/sedmitsata/otpisvane/[token]` | Digest unsubscribe: GET renders confirm button (Safe-Links-proof), POST unsubscribes — email-only entry **by design** |

### Admin/ambassador (`/admin/(protected)`, layout gate `requireAdmin()` = amb or admin; pages re-gate)
| Route | Gate | What it does |
|---|---|---|
| `/admin` | amb+ | Hub |
| `/admin/moderation` | amb+ (scope via SQL join) | Photo/report/facility queues, SLA figures, prescreen flags display |
| `/admin/verify` | amb+ | Verify deck for `needs_verification` (V-keystroke flow) |
| `/admin/facilities`, `/admin/facilities/[id]` | admin | Search + full facility edit |
| `/admin/import`, `/admin/import/[jobId]` | admin | OSM import trigger (dry-run/live+confirm), run history, per-job report |
| `/admin/obshtini` | admin | Municipal CSV inbox: parse → preview → per-row conflict resolve → commit |
| `/admin/sesii` | admin | Bulk session create: grid form + CSV path |
| `/admin/rezultati`, `/admin/rezultati/[occurrenceId]` | admin | Results entry + CSV import |
| `/admin/kampanii`, `…/nova`, `…/[slug]` | admin | Campaign CRUD, publish/cancel(confirm)/close(type-word), admin standings with real names |
| `/admin/ambasadori` | admin | Grant/revoke role (confirm), municipality scope add/remove (confirm), activity stats |
| `/admin/otcheti` | admin | Grant-report preview + CSV/HTML export links |

## B. Route handlers (14)

| Endpoint | Auth | What |
|---|---|---|
| `GET /api/health` | none | DB + PostGIS `ST_DWithin` smoke |
| `ALL /api/auth/[...all]` | better-auth | OTP issue/verify, session, sign-out |
| `GET /api/facilities` | none | Public facility GeoJSON with filter params; visibility predicate |
| `GET /api/stats` | none | Stats JSON from `mv_*` |
| `GET /api/widget/obshtina/[city]` | none, CORS-open, frameable | Self-contained aggregate widget (HTML / `?format=json`); the ONLY route exempt from `X-Frame-Options: DENY` |
| `GET /api/opendata/v1/[dataset]` | anon or `Bearer` key (key = higher rate limit only) | Catalogue-driven dataset export (GeoJSON/CSV/JSON), RateLimit headers, fails open |
| `GET /api/opendata/v1/dumps` | none | Dump version listing from `opendata_dumps` |
| `GET /api/opendata/v1/dumps/[version]/[file]` | none | Dump download; storage key read from DB row; `immutable` |
| `GET /api/admin/otcheti?format=csv\|html` | admin (DB role) | Grant-report artifact |
| `GET /kalendar/[token]` | token (credential; rotatable) | Member iCal subscription feed; 404 flat |
| `GET /kalendar/sesiya/[name].ics` | none | One-occurrence .ics download |
| `GET /sitemap.xml`, `/sitemaps/[name]` | none | Sitemap index + chunks |
| `GET /tiles/[...path]` | none | Self-served pmtiles range requests |

## C. Server actions (44 across 19 files)

| File | Actions | Who |
|---|---|---|
| `vhod/actions` | `signInAction` (OTP two-phase), `googleSignInAction` (flag-gated, ships off → dormant), `signOutAction` | anon / user |
| `dobavi/actions` | `addFacilityAction` (photo req., dup guard, → `needs_verification`, points, audit) | user |
| `obekt/[slug]/contribution-actions` | `verifyFacilityAction` (checklist → edits + points), `reportConditionAction` (state+tags+photo → edits + condition + points 1/day) | user |
| `obekt/[slug]/report-actions` | `submitReport` (anonymous problem report; honeypot + rate limit) | anon+ |
| `otmetka/[token]/actions` | `redeemCheckinAction` (verify sig→window→session; distance_m only; scored iff `qr`; capped 3/day) | user |
| `sesiya/[occurrenceId]/actions` | `rsvpAction`, `withdrawAction` (order-only RSVP; withdraw diffs promotions; enqueues `session.notify`) | user |
| `profil/actions` | `updateProfileAction`, `deleteAccountAction` (GDPR erasure), `setDigestSubscriptionAction`, `calendarTokenAction` (rotate) | user |
| `pasport/actions` | `setPassportVisibilityAction` (minor-locked), `acknowledgeBadgesAction` (implicit on view) | user |
| `sedmitsata/otpisvane/[token]/actions` | `confirmUnsubscribeAction` | token |
| `danni/klyuchove/actions` | `createApiKeyAction`, `revokeApiKeyAction` | user |
| admin `moderation/actions` | `decidePhoto`, `resolveReport`, `decideFacility` (all scope-joined; decisions logged append-only) | amb+ |
| admin `verify/actions` | `decideFacility` (verify deck save) | amb+ |
| admin `facilities/actions` | `saveFacility` | admin |
| admin `import/actions` | `enqueueImport` (→ `import.osm` job; singleton conflict → `?conflict`) | admin |
| admin `obshtini/actions` | `parseCsvAction`, `previewCsvAction`, `commitCsvAction` (re-classifies server-side; merge policy) | admin |
| admin `sesii/actions` | `parseCsvAction`, `previewCsvAction`, `commitCsvAction`, `createGridAction` (all → `play_sessions`; enqueue materialize) | admin |
| admin `rezultati/actions` | `saveResultsAction`, `parseResultsCsvAction`, `previewResultsCsvAction`, `commitResultsCsvAction` | admin |
| admin `kampanii/actions` | `createCampaignAction`, `updateCampaignAction`, `publishCampaignAction`, `cancelCampaignAction`, `closeCampaignAction` (freeze) | admin |
| admin `ambasadori/actions` | `grantAmbassadorAction`, `revokeAmbassadorAction`, `addMunicipalityAction`, `removeMunicipalityAction` | admin |

## D. Jobs & schedules (pg-boss, 9 queues, worker `apps/worker`)

| Queue | Trigger | Effect |
|---|---|---|
| `health.check` | manual/none scheduled | liveness probe |
| `import.osm` | admin UI (`enqueueImport`) | Geofabrik download (cached) → tag mapping → merge policy → `facilities` + `facility_edits`; report on `/admin/import/[jobId]` |
| `stats.refresh` | `*/15 * * * *` + on-boot | refresh `mv_municipality_stats`, `mv_national_stats`, `mv_sport_stats` |
| `auth.cleanup` | `17 3 * * *` | purge expired `verifications` |
| `session.materialize` | `7 * * * *` + on-boot + after bulk-create | expand RRULEs → `play_session_occurrences` (8-week window, idempotent, DST-resolved) |
| `session.notify` | RSVP/withdraw/cancel actions (occurrence ids + ACCOUNT ids, never addresses) | resolve inbox at send time; claim `play_session_notifications` ledger in-tx; send rsvp_confirmed / rsvp_waitlisted / promoted / occurrence_cancelled |
| `session.reminders` | `*/10 * * * *` | "within lead time AND not yet told" against ledger → reminder_24h / reminder_2h |
| `digest.weekly` | `0 8 * * 1` Europe/Sofia | `weeklyDigest` query → idempotent via `digest_sends` → opt-in member mail |
| `opendata.dump` | `40 3 * * *` Europe/Sofia | versioned GeoJSON/CSV dumps → storage + `opendata_dumps` row after hash |

## E. Outbound email (all through `Mailer`; prod without SMTP sends NOTHING)

| Mail | Trigger |
|---|---|
| OTP sign-in code | `signInAction` via better-auth |
| rsvp_confirmed / rsvp_waitlisted / promoted / occurrence_cancelled | `session.notify` job |
| reminder_24h / reminder_2h | `session.reminders` job |
| Weekly digest (per city, opt-in) | `digest.weekly` job |

## F. Operator CLI (package scripts; op-invoked in sessions)

`db:start/generate/migrate/seed/reset` · `import:osm` + `import:osm:audit` (CLI twin of the job)
· `mod:queue` (read-only prescreen listing) · `mod:flag` (writes `moderation_flags` ONLY — assistive)
· `tiles:build` · `stats:launch-report` · `report:quarterly` / `report:grant` (Playwright HTML→PDF)

## G. Tables (32) and their writers

| Table | Writers |
|---|---|
| `users` | better-auth signup; profile action; role actions (grant/revoke amb); erasure |
| `sessions` / `accounts` / `verifications` | better-auth; `auth.cleanup` purges verifications; session-IP CHECK forbids IP persist |
| `account_deletions` | `deleteAccountAction` (erasure ledger) |
| `municipalities` | seed/boundary import (op) |
| `municipality_population` | seed (NSI figures) |
| `sources` | seed / imports |
| `facilities` | OSM import job, municipal CSV commit, `addFacilityAction`, `saveFacility`, moderation `decideFacility`, migration 0016 (20 hiking landmarks, data-only) |
| `facility_edits` | **append-only audit** — every facility writer above; UPDATE only for erasure anonymisation |
| `facility_photos` | add-facility, condition report; `decidePhoto` |
| `facility_reports` | `submitReport`; `resolveReport` |
| `facility_condition_reports` | `reportConditionAction` |
| `points_ledger` | contribution actions + QR check-in scorer — `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`, append-only, earn-only |
| `ambassador_municipalities` | admin ambasadori actions |
| `moderation_decisions` | append-only; every moderation decision |
| `moderation_flags` | `mod:flag` CLI only (assistive, never decides) |
| `play_sessions` | admin bulk-create (grid + CSV); organizer-erasure trigger cancels |
| `play_session_occurrences` | `session.materialize` ONLY; cancel actions update status |
| `play_session_rsvps` | rsvp/withdraw (order-only; state flips) |
| `play_session_checkins` | `redeemCheckinAction` (+ organizer/self recorded, never scored — CHECK) |
| `play_session_notifications` | notify/reminder jobs (two partial unique keys) |
| `play_session_results` | admin rezultati actions; erasure anonymises |
| `calendar_tokens` | `calendarTokenAction` (rotate = replace row) |
| `digest_subscriptions` | `setDigestSubscriptionAction`, `confirmUnsubscribeAction` |
| `digest_sends` | `digest.weekly` (idempotency) |
| `user_badges` | acknowledge action ("told" flag ONLY — never decides badge held) |
| `campaigns` | admin kampanii actions |
| `campaign_results` | `closeCampaignAction` freeze (no display names stored) |
| `api_keys` | key actions; `key_hash` CHECK-pinned to 64 hex |
| `opendata_dumps` | dump job (row after file hashed) |

Views: `leaderboard_eligible_members` (THE minor/opt-in gate — every board joins it),
`play_session_rsvp_positions` (going/waitlist by row_number), `mv_municipality_stats`,
`mv_national_stats`, `mv_sport_stats` (refreshed by `stats.refresh`).

## H. Capability delta vs previous inventory

N/A — first run. For the record, capabilities landed in the last five commits (design
seed reconciliation → `00707c1`) + working tree: `/sesii` index page, global footer
(statistika/danni/privacy links), redesigned map markers, hiking-landmarks data layer
(0016), confirmation-dialog policy, campaign-form event-kind restriction.

## I. ORPHANED / dormant / buried (invocation-path findings)

| Item | Status |
|---|---|
| `googleSignInAction` | **Dormant by flag** (`AUTH_GOOGLE_ENABLED` ships off) — intended |
| `/api/widget/obshtina/[city]` | **Orphaned in-app by design** (external embed surface) |
| `confirmUnsubscribeAction` | Email-only entry **by design** |
| `redeemCheckinAction` | QR-scan-only entry **by design** |
| `/kampanii*` | **BURIED**: no nav entry (Сесии tab now correctly → `/sesii`) |
| `/sedmitsata/[city]` | **BURIED**: email/SEO only |
| `/obshtina/[city]` | **BURIED**: reachable only via `/igrishta/[city]` link; no index |
| `health.check` queue | No producer found besides worker boot — verify in STEP 3 |
| `/design-system` | Dev showcase publicly routable — check noindex in STEP 3 |
| 4.3 organizer roster/manual check-in deck | **Not built** (ROADMAP open) — organizer has QR screen only |
