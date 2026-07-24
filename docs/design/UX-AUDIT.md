# UX audit — real flows, driven

Method: walked each flow in the running app (browser automation) at 390px (primary)
and 1280px, signed in as an admin account. Screenshots in `docs/design/audit/`.
Severity: **P0** blocks the task · **P1** causes drop-off · **P2** polish.

## Summary

| # | Flow | Verdict | Worst |
|---|---|---|---|
| 1 | Anonymous → nearby free facility → report | works, degraded on mobile/4G | P1 |
| 2 | SEO landing (`/igrishta/[city]`) | works well | P2 |
| 3 | Signup → add → verify → condition | works | P2 |
| 4 | Ambassador clears moderation on a phone | works, off-brand | P1 |
| 5 | Admin import + verify fast | works, unguarded | P1 |
| 6 | Find session → RSVP → reminder → QR | **discovery unbuilt** | **P0** |
| 7 | Passport · badges · leaderboard · challenge | works; challenge empty | P1 |

Cross-cutting **P1**: there is **no global footer / institutional nav**, so `/statistika`,
`/danni` (open data), `/obshtina/[city]` (accountability) have no in-app entry point —
for a ministry-credibility NGO these trust pages should be one tap from anywhere.

---

## Flow 1 — Anonymous: nearby free facility → report a problem  (390 + desktop)

**Intent.** Standing outside, find a free facility near me; flag one that's broken.
**Walk (≈6–7 taps).** Land `/` (free filter is default-on) → *Намери ме* / near-me →
tap a marker or card → in-sheet preview → *Виж детайли* → `/obekt/[slug]` → scroll →
*Съобщи проблем* → pick issue + *Изпрати*.

- **P1 — the *Намери ме* locate control is occluded by the bottom sheet.** It sits at
  `bottom-[168px]`; at the default (half) and full snaps the sheet covers it — verified
  the top element at the control's centre is a result-card `<span>`, and tapping it
  produced no change or feedback. The primary "find nearby" action is untappable by
  touch; only the near-me toggle inside the filter sheet (2 taps deeper) still works.
  *Fix:* anchor the floating controls above the sheet's max peek height (or move locate
  into the sheet header); give the button a visible locating/error state.
  (`docs/design/audit/map-discovery-390.png`)
- **P1 — 4G: the map downloads the full 1.0 MB national GeoJSON (6027 features) on load
  and again on every filter change.** No viewport scoping. Outdoors on 4G the map is slow
  to populate and each chip toggle re-fetches ~1 MB. *Fix:* a bbox/viewport-scoped
  facility endpoint (tiling), or cap + lazy-load; at minimum cache per filter key.
- **P2 — report is 3 taps deep.** The map preview offers only *Упъти ме* / *Виж детайли*;
  reporting lives only on the full detail page. Acceptable, but a *Съобщи* affordance on
  the preview would shorten the "it's broken" path.
- **P2 — the default "free only" filter is invisible.** Nothing tells the anonymous user
  that paid facilities are being hidden; no active "безплатни" chip. *Fix:* surface the
  active free filter as a removable chip.
- **Offline:** the map renders a real offline banner (built). Good. **Desktop:** the list
  panel is always visible, so locate isn't occluded there — the P1 is mobile-only.

## Flow 2 — SEO landing  (390) — `docs/design/audit/audit-seo-etropole.png`

**Intent.** Arrived from search on `/igrishta/etropole`. This is a large share of real traffic.
Strong page: honest H1 + count ("10 безплатни обществени спортни съоръжения"), links to
the map, the municipality's accountability page, per-sport filters, and every facility
(all valid `/obekt/[slug]`). No dead links, no buttons to mis-fire.

- **P2 — "Виж всички на картата" → `/`** lands on the whole-Bulgaria map, losing the
  Etropole context the visitor arrived with. *Fix:* link to a city-scoped map view
  (`/?z=..&lat=..&lng=..` on the municipality centroid, or a `?bbox=`).
- **P2 — a11y:** facility card link text concatenates name + sport ("Спортно
  съоръжениетенис") into one token for screen readers. *Fix:* a visually-hidden separator
  or an `aria-label`.

## Flow 3 — Signup → add → verify → condition  (390) — `add-facility-390.png`

**Walk.** `/vhod` (email → OTP code → submit) → `/dobavi` (adjust pin, photo, sport chips,
access, name) → submit → `/obekt/[slug]` → *Потвърди* (verify, prefilled) → condition
state + *Изпрати*. Add-facility and both contribution forms are on the seed design; verify
is a 1-tap prefilled confirm; condition is short. Works.

- **P2 — native file input reads "Choose File" (English).** The browser's built-in control
  text isn't localizable; the label/hint around it are Bulgarian. *Fix:* a custom button
  that proxies to a hidden `<input type=file>`, or accept the platform default.
- **P2 — post-submit destination unverified.** The add-facility success path (where the
  member lands after "Добави съоръжението") should be confirmed to reach the new facility
  (or a clear confirmation), not a bare reload. *(Not driven to submit in this pass.)*

## Flow 4 — Ambassador clears moderation on a phone  (390) — `audit-admin-moderation.png`

**Walk.** `/admin` → *Модерация* → per item *Потвърди* / *Няма го* (facilities),
*Одобри* / *Отхвърли* (photos). **1 tap per decision**, large buttons, usable at 390 —
20 items ≈ 20 taps + scroll. Achievable.

- **P1 — the admin console is undesigned.** Plain green text-nav that wraps to 4 lines at
  390 (small tap targets), raw `bg-green-600`/`bg-red-600` buttons instead of the seed
  tokens, no seed shell. It works but is off-brand and cramped on a phone — and this is a
  phone-first task. *Fix:* an admin-shell pass onto the primitives/tokens (nav, buttons,
  cards). RECONCILIATION already flags admin as UNDESIGNED.
- **P2 — "Няма го" (marks a facility `gone`) fires with no confirmation.** Consequential,
  one tap. For throughput a confirm hurts; prefer an **undo** toast over silent commit.
- **P2 — 6601 pending items** (6582 facilities `needs_verification`); the "median time to
  decision 0.0 ч" reads as healthy while the backlog is enormous. Dashboard framing
  understates the queue. No queue filter/sort for a scoped ambassador.

## Flow 5 — Admin: trigger import + verify fast  (390) — `audit-admin-import.png`

**Walk.** `/admin` → *Импорт* → *Пробен импорт (dry-run)* / *Жив импорт*; then *Проверка*
(`/admin/verify`, a rapid VerifyDeck linked as "Провери следващите →").

- **P1 — "Жив импорт" has no confirmation.** It re-imports OSM and overwrites osm-set
  fields across thousands of rows on a single tap. *Fix:* confirm dialog for the live run
  (dry-run needs none).
- **P1 — no worker-status → silent failure.** The page says "the worker must be running"
  but doesn't show whether it is. Enqueue with the worker down = a job that never runs and
  no error ("Последни изпълнения" stays empty). *Fix:* show worker/queue health and the
  job's state (queued/running/failed) with polling.

## Flow 6 — Find session → RSVP → reminder → QR  (390) — `audit-weekly-empty.png`

- **P0 — no way to discover a session in-app.** There is no public sessions index. The
  only listing is `/sedmitsata/[city]` (the weekly page), reachable only via the digest
  email or a typed URL — no nav link. The map's *Сесии* tab points at `/kampanii`
  (campaigns), not sessions. A member cannot reach step 1 of this flow.
- **P0 / unbuilt — members can't create a session.** The weekly page invites *"предложи
  своя тренировка"* but there is no affordance; session creation is admin-only
  (`/admin/sesii` bulk-create). Member organizer tools are Stage 4.3 (the next unchecked
  roadmap item). The copy promises a capability that doesn't exist.
- **Built but stranded:** RSVP (`rsvpAction`/`withdrawAction`), the session page
  (`/sesiya/[occurrenceId]`), reminders, and QR check-in (`/otmetka/[token]`,
  `redeemCheckinAction`) all exist and work — but are reachable only by direct link, email,
  or scanning a physical QR. The back end is done; the front door is missing.
- *Fix (interim, no new backend):* point *Сесии* at the weekly/sessions surface, link it
  from nav, and remove or soften "предложи тренировка" until organizer tools ship. *Fix
  (real):* a public sessions browse (by city / near-me / sport).

## Flow 7 — Passport · badges · leaderboard · challenge  (390)

`audit-passport.png`, `audit-leaderboard.png`, `audit-campaigns-empty.png`.
Passport works (points, streaks, *Направи публичен* visibility; links to leaderboard +
profile). Badges are derived and shown. Leaderboard works — 29 sport filters + period,
all shareable links. Reachable via the *Класации* and *Профил* tabs.

- **P1 — "join a challenge" has no entry and no data.** Campaigns score everyone
  automatically (no join button, by design), and none are seeded — `/kampanii` shows
  "В момента няма обявени кампании." Because the **Сесии tab lands here**, a Sessions-
  labelled tab opens an empty Campaigns page. *Fix:* fix the tab target (Flow 6); seed a
  demo campaign for QA.
- **P2 — campaigns empty state is a bare dead-end** (no next action). *Fix:* add a CTA
  (e.g. *Виж класацията* / *Добави съоръжение*).

---

## Cross-cutting

- **P1 — no global footer / institutional nav.** `/statistika`, `/danni` (open data + API
  keys), `/obshtina/[city]` (accountability) have **no in-app entry point** — only URL,
  SEO, or (for the weekly page) email. `/privacy` is reachable only from `/profil` and the
  report form. *Fix:* a persistent footer (or "още" menu) with Статистика · Отворени данни
  · Отчетност · Поверителност — the transparency surfaces a public-money NGO leans on.
- **P2 — back-nav cost.** *Виж детайли* is a full route change to `/obekt/[slug]`; back
  re-inits MapLibre and re-fetches ~1 MB (context is preserved via `?selected`+viewport,
  but the reload is real on 4G). The map-mounted in-sheet drill is used only for the
  minimal preview, not the full detail.
- **Offline:** map has a banner; a service worker is registered (some shell caching). SSR
  pages offline fall back to the browser error unless SW-cached — not deeply exercised.
