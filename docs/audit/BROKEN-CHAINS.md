# Broken chains — audit run 2026-07-24

Each capability driven and asked four questions: **WIRED** (invoking it produces the
intended state change, surviving a refresh and a job retry?), **EXPOSED** (a visible
control in the right place for every permitted role?), **CONNECTED** (do downstream
effects reach everywhere they should?), **PRESENTED** (loading / success / error / a
path back?). Gaps ranked **P0** (breaks a chain / loses data) · **P1** (unreachable or
user uninformed) · **P2** (friction). Everything not listed as a gap passed all four —
see E2E-RESULTS.md.

---

## Findings this run

### AUDIT-F1 — Session creation is blind to ~70% of facilities · **P1**
- **WIRED** ✓ · **CONNECTED** ✓ · **PRESENTED** ✗ · **EXPOSED** ✗
- `/admin/sesii` loads the facility picker with `LIMIT 2000` ordered by municipality
  name (`sesii/page.tsx` `FACILITY_LIMIT`), against **6,672** non-gone facilities. Any
  facility past the ~2000th row (every municipality alphabetically after roughly the
  letter "Н") is **not in the list, with no truncation indicator**. Driven live: the
  audit facility in Невестино (rank 2402) could not be found or ticked; the pipeline
  had to fall back to an in-cap facility. Evidence: `p9-facility-cap.txt`.
- **Failure scenario:** an operator in Шумен / Ямбол cannot create a session at their
  own facility and is given no reason.
- **Fix:** server-side search (the box already exists; make it query the DB) or paginate;
  at minimum surface "showing 2000 of 6672".

### AUDIT-F3 — Municipal CSV rejects Bulgarian sport names · **P1**
- **WIRED** ✓ (English tokens) · **PRESENTED** ✓ (per-row reasons) · **EXPOSED** ✓ ·
  **CONNECTED** ✗ for real input
- `normalize.ts` maps Bulgarian synonyms for **access** and **lighting** but not for
  **sports** (`splitSports` only lowercases; `CANONICAL_SPORTS` are English). Every row
  with `спорт=футбол/баскетбол` becomes "невалиден ред: Непознат спорт". Stage 6.3's own
  claim — "reads Bulgarian or English enum values" — holds for every column **except the
  one a Bulgarian municipal registry will always write in Bulgarian**. Evidence:
  `p8-sport-alias-finding.txt`.
- **Failure scenario:** a real обшина CSV imports zero rows; the operator sees only
  "unknown sport" three hundred times.
- **Fix:** a `SPORT_ALIASES` table mirroring `ACCESS_ALIASES`.

### AUDIT-F2 — Stats do not reconcile with the map on a null-slug row · **P2**
- **CONNECTED** ✗ (edge)
- `mv_national_stats` counts `status <> 'gone'`; the map/API/export predicate is
  `status <> 'gone' AND slug IS NOT NULL`. One active null-slug row (an e2e leftover)
  makes `/api/stats` national.total **6672** vs the map's **6671**. The platform's own
  standard is "count the pins and get the same number". Every production writer slugs
  its rows, so this only bites when a slugless row exists — but the predicate exists
  because one can. Evidence: `p15-reconcile-finding.txt`.
- **Fix:** align the matview's WHERE with `PUBLIC_FACILITY_PREDICATE`. (Also: the e2e
  suite leaks fixture rows into the dev DB — hygiene.)

### AUDIT-F4 — Malformed CSV refused safely but feedback unverified · **P2 (PLAUSIBLE)**
- **WIRED** ✓ (safe refusal) · **PRESENTED** ? 
- An unterminated-quote CSV is correctly refused (nothing imported, wizard does not
  advance). But under automation the form reset to an empty textarea with **no visible
  red error** — the code path (`import-form.tsx:56`) says the message should render, so
  this is likely a harness artifact of the uncontrolled `<textarea defaultValue>`.
  **Safe-refusal CONFIRMED; user-visible feedback UNVERIFIED.** Evidence:
  `adv-corrupt-csv-finding.txt`. Needs a 30-second manual paste to close.

---

## Silent hops (state changes with no observable result for the affected role) · P1/P2

These are structural, from the code, and confirmed by driving. None loses data; each
leaves a user uninformed.

1. **Contributors are never told a moderation outcome** (P1). Add-facility, verify,
   condition-report, photo upload all succeed silently; the member learns of approval /
   rejection only by revisiting. No `session.notify`-style path exists for moderation.
   (`p1-silent-hop.txt`, and by construction for P3/P4/P5.)
2. **Anonymous reporters get nothing** (P2, by design — no address collected).
3. **Ambassadors are not notified of grant or revoke** (P1). Authority appears/vanishes
   between visits (P6).
4. **No worker-health indicator** (P2). A job queued with the worker down sits `created`
   forever and self-heals on restart (proven), but nothing tells the operator the worker
   is dead vs merely slow. Job *state* is visible; worker *liveness* is not.
5. **Materialize / stats-refresh failures surface nowhere in the admin UI** (P2). A
   failed matview refresh leaves `/statistika` quietly stale.

---

## ORPHANED / BURIED confirmed by driving

| Item | Status | Placement proposal |
|---|---|---|
| `/api/widget/obshtina/[city]` | ORPHANED **by design** (external embed) | none |
| Digest unsubscribe (`/sedmitsata/otpisvane/[token]`) | Email-only **by design** | none |
| QR check-in (`/otmetka/[token]`) | Scan-only **by design** | none |
| `googleSignInAction` | Dormant behind `AUTH_GOOGLE_ENABLED` (ships off) | none |
| `/kampanii`, `/kampanii/[slug]` | **BURIED** — no nav entry since the Сесии tab was fixed to `/sesii` | a "Кампании" card/sub-tab on `/sesii` |
| `/sedmitsata/[city]` | **BURIED** — email/SEO only | link "Тази седмица" from `/sesii` header |
| `/obshtina/[city]` | **BURIED** — reachable only via `/igrishta/[city]`; no index | a `/obshtina` picker + footer "Отчетност" |
| **Organizer roster / manual check-in deck (Stage 4.3)** | **NOT BUILT** | the only unbuilt roadmap item; QR screen exists, roster does not — an organizer cannot manually mark attendance or see who is coming beyond the count |

---

## Everything that passed all four (summary)
Auth+roles, minor derivation, crowd contribution + points, verify/condition, photo
moderation, ambassador scope (view **and** write), OSM import, municipal merge policy
(English input), the full 12-hop session lifecycle incl. DST, RSVP/waitlist/promotion
mail, reminders (idempotent), iCal + rotation, QR check-in (geofenced/scored/capped, no
coordinates stored), digest (idempotent, sessionless unsubscribe), passport/badges,
leaderboard eligibility, campaign create→freeze, open-data keys + dumps (hashed,
versioned, attributed, predicate-subset), widget hardening, GDPR erasure, append-only
audit, prescreen assistive-only, landmarks. Evidence per row in E2E-RESULTS.md.
