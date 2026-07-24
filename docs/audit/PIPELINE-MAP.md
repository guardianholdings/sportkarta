# Pipeline map — audit run 2026-07-24

First run — no archived map existed; every chain below was traced from code
(actions → lib/db functions → schema → worker → UI readers). A pipeline is a chain of
state changes crossing steps, roles, or systems. Per hop: **trigger → processing →
persistence → downstream → who sees what**. Hops with no observable result for anyone
are flagged **⚠ SILENT**.

---

## P1 — Anonymous problem report → moderation → facility change
1. Anon on `/obekt/[slug]` → *Съобщи проблем* form (honeypot, rate limit, optional EXIF-stripped photo) → `facility_reports(pending)`; reporter sees success state.
2. Report appears in `/admin/moderation` queue for amb (scope-joined) / admin, with prescreen flags if `mod:flag` ran.
3. `resolveReport` → `moderation_decisions` append; queue item leaves. If facility marked gone via `decideFacility` → `facilities.status='gone'` + `facility_edits` row → vanishes from map/API/exports/stats (next `stats.refresh`).
4. **⚠ SILENT to originator:** anonymous reporter is never notified of the outcome (no address collected — by design; note in BROKEN-CHAINS whether the facility page shows anything).

## P2 — Sign-in (email OTP) → session → role bootstrap
1. `/vhod` submit → better-auth issues OTP → **mail hop** (file transport dev / SMTP prod; prod without SMTP sends NOTHING — flagged in code as intended, still a deployment trap).
2. Code entry → session cookie (no IP persisted — CHECK) → redirect `/profil`. `ADMIN_EMAILS` address is promoted admin on sign-in.
3. DOB (optional) → `is_minor` derived, DOB discarded. Downstream: minor exclusion via `leaderboard_eligible_members`, passport visibility CHECK.
4. Google path dormant behind flag.

## P3 — Crowd add-facility → verification → public map
1. User `/dobavi` (pin+photo+sports) → dup guard (30 m) → `facilities(status=needs_verification, source=crowd)` + `facility_photos(pending)` + `facility_edits(created, actor=user)` + `points_ledger` award (idempotency-keyed) — user redirected to new `/obekt/[slug]`.
2. Facility enters `/admin/verify` deck + moderation queue (photo separately). Amb (in-scope) / admin verifies → `facilities.status='active'` + edits + decision log; verifier identity in audit.
3. Active facility → map `/`, `/api/facilities`, SEO pages, open-data exports (same predicate), stats matviews (next refresh), accountability page counts.
4. Points → `/pasport` (badges derive), `/klasirane` (if eligible), campaign scoring (if window).
5. **⚠ SILENT to originator:** no notification when their facility is approved/rejected — they discover by looking.

## P4 — Verify + condition-report contributions
1. User on `/obekt` verify checklist → `facility_edits` (crowd, field-level) + points (1/person/facility). Condition: state+tags+photo → `facility_condition_reports` + facility condition fields + points (1/person/facility/Sofia-day).
2. Crowd-set fields FREEZE future osm/municipal overwrites (merge policy).
3. Condition surfaces: facility page, `/obshtina/[city]` accountability, reports catalogue figures.

## P5 — Photo moderation
1. Upload (add/condition) → `facility_photos(pending)` — **not public yet**.
2. Amb/admin `decidePhoto` approve/reject → decision log; approved photo renders on `/obekt`.
3. **⚠ SILENT to originator** (no notification; uploader sees photo appear or not).

## P6 — Ambassador lifecycle
1. Admin `/admin/ambasadori` grant (confirm) → `users.role='ambassador'` + scope rows in `ambassador_municipalities`.
2. Ambassador sees `/admin` hub link on `/profil`; moderation/verify queues filtered to scope **in SQL** (out-of-scope decision updates zero rows).
3. Revoke/remove-municipality (confirm) → authority shrinks; **⚠ SILENT to the ambassador** — no notification of grant or revoke; they discover on next visit.

## P7 — OSM import
1. Admin `/admin/import` dry-run or live (confirm) → `enqueueImport` → `import.osm` job (singleton; `?enqueued` / `?conflict` feedback).
2. Worker: cached Geofabrik PBF → tag mapping → merge policy (crowd > municipal > osm, field-level) → `facilities` upserts + `facility_edits(source=osm, actor=NULL)`.
3. Report on `/admin/import/[jobId]`; **worker down = queued job sits silently** (known P2 gap: no worker-health indicator).
4. Downstream: map/API/SEO/stats/exports. Crowd-verified fields untouched (policy tests).

## P8 — Municipal CSV inbox
1. Admin `/admin/obshtini` upload → parse (normaliser: bg/en enums, comma decimals) → preview classify new/match/conflict/invalid (PostGIS distance+name; auto-match ≤40 m + name).
2. Per-row conflict resolution (skip/link/new) → commit **re-classifies server-side**; tampered link refused.
3. Writes: new rows `source=municipal, needs_verification`, `ST_Contains` municipality, provenance `attrs.municipal`, audit rows, `actor=NULL`; updates via `mergeFields` (municipal-over-osm applies, crowd freezes). Unchanged re-import writes nothing.
4. New rows flow into the SAME verify deck as crowd adds (P3.2).

## P9 — Session lifecycle (the longest chain)
1. Admin `/admin/sesii` grid/CSV → `play_sessions` (wall-clock `starts_at_local`, RRULE subset) → enqueue materialize.
2. `session.materialize` (hourly + on-demand) → `play_session_occurrences` 8-week rolling, `ON CONFLICT DO NOTHING`, DST resolution recorded per row (gap_shifted / fold_first).
3. Occurrences appear on `/sesii`, `/sedmitsata/[city]`, session pages, iCal feeds.
4. RSVP (`rsvpAction`) → arrival-ticket row; position derives going/waitlisted (view) — user sees state inline; enqueue `session.notify` → **mail** rsvp_confirmed / rsvp_waitlisted (ledger-deduped, re-entrant per `rsvp_seq`).
5. Withdraw → state flip; in-tx diff of "who was going" → promoted members enqueued → **mail** promoted. Concurrent withdrawals overlap safely (ledger dedupe).
6. `session.reminders` (*/10) → "within lead AND not told" → **mail** reminder_24h/2h; missed windows mail nobody (self-healing, no back-send).
7. Cancellation (series/occurrence) → future occurrences only → **mail** occurrence_cancelled; iCal keeps event as `STATUS:CANCELLED` + bumped `SEQUENCE`.
8. iCal: member feed `/kalendar/[token]` (credential; rotate kills old URL); per-occurrence `.ics` public download.
9. Organizer QR screen `/sesiya/[id]/qr` (organizer/admin only): server-rendered SVG, 60 s-window HMAC token, meta-refresh rotation. No client JS.
10. Member scans → `/otmetka/[token]` → `redeemCheckinAction`: signature before clock (timingSafeEqual), geofence → **`distance_m` only** stored, `scored` iff method=qr (CHECK), points capped 3/day; attendance ALWAYS recorded, only payment stops. All failures read identically.
11. Results: admin `/admin/rezultati` manual or CSV → `play_session_results` (free-text score; no timing hardware).
12. Downstream of 10–11: points → passport/badges/leaderboards/campaigns; check-in facts → reports (by METHOD, never summed).

## P10 — Weekly digest
1. Member `/profil` opt-in per city → `digest_subscriptions`.
2. `digest.weekly` Monday 08:00 Sofia → `weeklyDigest` query (same as page) → claim `digest_sends` in-tx → **mail** with unsubscribe token link.
3. `/sedmitsata/otpisvane/[token]`: GET = confirm button only; POST unsubscribes → `digest_subscriptions` delete; works sessionless.
4. Page twin `/sedmitsata/[city]` renders identical content.

## P11 — Passport & badges
1. Events (points_ledger + qr check-ins) → pure fold in `lib/src/badges` → badges DERIVED at read; `user_badges` only records "told" (acknowledge on view).
2. Streaks: civil Sofia days/weeks. New badge in catalogue = retroactive award with true date.
3. `/pasport` (own) → toggle public (minor-locked allowlist CHECK) → `/pasport/[handle]` (random handle, noindex, aggregate-only).

## P12 — Leaderboards
1. `points_ledger` → `/klasirane` national/city/sport × all-time/month.
2. EVERY board joins `leaderboard_eligible_members` (adult AND opted-public) — the single gate. Check-ins not ranked.

## P13 — Campaigns
1. Admin create (draft) → publish → visible `/kampanii`; scoring = validated `rules` JSONB compiled to weighted SQL over ledger + **qr-only** check-ins; civil-Sofia window, `ends_on` inclusive; per-day cap.
2. Live standings: public page gates DISPLAY (individual = adult+public; city = counts everyone incl. minors, min-member suppression); admin page shows real names (prize handover).
3. Close (type-word) → freeze into `campaign_results` (rank+score, NO display name — identity resolves live) → `/kampanii/[slug]/rezultati`. Cancel (confirm) → republishable.

## P14 — Open data
1. User `/danni/klyuchove` create key (instant; shown once; hash CHECK-pinned) → higher rate budget; revoked/unknown key falls to anon budget, never 401.
2. `GET /api/opendata/v1/[dataset]` — catalogue-generated SELECT; visibility predicate shared with map; RateLimit headers; 429+Retry-After → points at dumps; fails open; NO request log.
3. `opendata.dump` nightly → versioned files (Sofia date in path, VERSION-stamped, byte-identical re-runs) → `opendata_dumps` row after hash → listing + download routes; dumps not rate-limited.
4. `/danni` docs render from the same catalogue.

## P15 — Reports & stats
1. `stats.refresh` (*/15) → `mv_*` → `/statistika`, `/api/stats`, accountability pages, coverage figures in reports (reconciliation-tested equal).
2. Admin `/admin/otcheti` GET-form scope → preview; `/api/admin/otcheti?format=csv|html` artifact; methodology prints per-figure SQL; suppression per REPORT (public k<5; ministry annex none; zero never suppressed; missing = em dash).
3. `report:quarterly` / `report:grant` CLI → HTML→PDF (no server-side Chromium).

## P16 — GDPR erasure
1. `deleteAccountAction` (type-to-confirm) → profile removed, contributions anonymised ("бивш потребител"), `facility_edits` intact, results anonymised via trigger-safe path, organizer sessions cancelled by trigger, `account_deletions` row.
2. Downstream: leaderboards/passport rows vanish (view re-resolves), frozen campaign placings keep rank lose name, session mail jobs resolve account → nothing to send.

## P17 — Widget & embeds
`/api/widget/obshtina/[city]` (+`?format=json`): self-contained, script-src 'none', no cookie, ODbL; the only frameable route (negative-lookahead header rule). Municipality embeds it; changes flow from the same aggregates.

## P18 — Moderation prescreen (operator loop)
`mod:queue` (read-only) → operator session judgment → `mod:flag` writes `moderation_flags` ONLY → flags render next to queue items (assistive, never decide).

## P19 — Hiking landmarks (0016, data-only)
Migration inserts 20 OSM-referenced peaks/landmarks (`source=osm`, curated attr, audit rows) → map/API/exports like any facility; importer can never collide (keys on sports-facility candidates only).

---

## Cross-cutting silent-hop register (candidates for BROKEN-CHAINS)
- P1.4 / P3.5 / P5.3 — contributors and reporters never notified of moderation outcomes.
- P6.3 — ambassadors not notified of grant/revoke.
- P7.3 — queued job + dead worker = silence (`/admin/import` shows only an empty history).
- P2.1 — prod with SMTP unset silently sends nothing (deliberate; still a deployment trap).
- P9.2 — materialize failures surface nowhere in admin UI.
- P15.1 — stats staleness (matview refresh failure) invisible on `/statistika`.
