# Coverage matrix — capability ↔ control

Every capability in the codebase (server actions, API route handlers, admin ops,
job triggers, exports, role-gated abilities) mapped to its UI entry point, verified
by driving the running app. "Taps" = from the relevant landing surface for that role
(public: the map `/`; member: `/profil`; admin: `/admin`). Status:

- **EXPOSED** — a role can reach it on a sane path.
- **BURIED** — callable, has a UI, but unreachable within a sane path for its role
  (no nav link; URL/SEO/email only).
- **ORPHANED** — callable with **no UI at all** (or in-app UI is impossible by design).

## Public / member

| Capability (fn / route) | Roles | Entry point — route · affordance (bg) | Taps | Status |
|---|---|---|---|---|
| Map + facilities (`facilitiesGeoJSON`, `/api/facilities`) | all | `/` · *Карта* tab | 0 | EXPOSED |
| Filter facilities (sport/access/lighting/surface/near-me) | all | `/` · *Филтри* + chips | 1–2 | EXPOSED |
| Search facilities | all | `/` · search box | 1 | EXPOSED — *client-side name match only; no server search* |
| Facility detail (`getFacilityBySlug`) | all | `/obekt/[slug]` · card/marker → *Виж детайли* | 2–3 | EXPOSED |
| Directions | all | `/obekt` · *Упъти ме* (+ preview) | 1–2 | EXPOSED |
| Report problem (`submitReport`) | anon+ | `/obekt` · *Съобщи проблем* | 3–4 | EXPOSED — buried in detail |
| Verify facility (`verifyFacilityAction`) | user+ | `/obekt` · *Потвърди* | 3–4 | EXPOSED |
| Report condition (`reportConditionAction`) | user+ | `/obekt` · *Изпрати* | 3–4 | EXPOSED |
| Add facility (`addFacilityAction`) | user+ | `/dobavi` · add-FAB / *Профил* | 1 | EXPOSED |
| Sign in / OTP (`signInAction`) | anon | `/vhod` · *Профил* tab (logged out) | 1 | EXPOSED |
| Google sign-in (`googleSignInAction`) | anon | `/vhod` | 1 | EXPOSED — *ships off (`AUTH_GOOGLE_ENABLED`)* |
| Sign out (`signOutAction`) | user+ | `/profil`,`/admin` · *Изход* | 1 | EXPOSED |
| Update profile (`updateProfileAction`) | user+ | `/profil` · *Запази* | 1 | EXPOSED |
| Delete account (`deleteAccountAction`) | user+ | `/profil` · *Изтрий профила ми* (confirmation input) | 1 | EXPOSED — gated |
| Rotate calendar token (`calendarTokenAction`) | user+ | `/profil` · *Смени адреса* | 1 | EXPOSED |
| iCal feed (`/kalendar/[token]`) | token | calendar-panel on `/profil` | 1 | EXPOSED |
| Digest subscribe (`setDigestSubscriptionAction`) | user+ | `/profil` · digest panel | 1 | EXPOSED |
| Digest unsubscribe (`confirmUnsubscribeAction`) | token | `/sedmitsata/otpisvane/[token]` | email | **ORPHANED in-app** (by design) |
| Passport (view + badges) | user+ | `/pasport` · *Профил → Спортен паспорт* | 2 | EXPOSED |
| Passport visibility (`setPassportVisibilityAction`) | user+ | `/pasport` · *Направи публичен* | 2 | EXPOSED |
| Acknowledge badges (`acknowledgeBadgesAction`) | user+ | `/pasport` (implicit on view) | — | EXPOSED (implicit) |
| Leaderboard | all | `/klasirane` · *Класации* tab | 0–1 | EXPOSED |
| Campaign list / detail / results | all | `/kampanii`,`/kampanii/[slug]` · *Сесии* tab | 0–1 | EXPOSED — **nav mislabel + no data** |
| RSVP / withdraw (`rsvpAction`,`withdrawAction`) | user+ | `/sesiya/[occurrenceId]` | direct/email | **BURIED** — no session discovery |
| QR check-in (`redeemCheckinAction`) | user+ | `/otmetka/[token]` · scan QR | QR | **ORPHANED in-app** (by design — scan at venue) |
| Organizer QR screen (`/sesiya/[occurrenceId]/qr`) | organizer/admin | direct | — | **BURIED** — member organizer tools unbuilt (Stage 4.3) |
| Weekly city page | all | `/sedmitsata/[city]` | email/SEO | **BURIED** — no nav |
| Accountability (`/obshtina/[city]`) | all | linked from SEO `/igrishta/[city]` | 1 (from SEO) | **BURIED** — no nav |
| Public statistics (`/statistika`, `/api/stats`) | all | — | URL/SEO | **BURIED** — no nav |
| Open-data portal (`/danni`) | all | — | URL | **BURIED** — no nav |
| Create / revoke API key (`createApiKeyAction`,`revokeApiKeyAction`) | user+ | `/danni/klyuchove` | URL | **BURIED** — no path to `/danni` |
| Open-data API + dumps (`/api/opendata/*`) | all / key | `/danni` docs + API | URL | BURIED (docs) · EXPOSED (API) |
| Embeddable widget (`/api/widget/obshtina/[city]`) | all | external embed | — | **ORPHANED in-app** (by design) |
| Privacy (`/privacy`) | all | `/profil` + report form | 1 | EXPOSED |

## Admin / ambassador

| Capability | Roles | Entry point | Taps | Status |
|---|---|---|---|---|
| Admin hub (`/admin`) | ambassador/admin | `/profil` · *Админ панел* | 1 | EXPOSED |
| Moderate facility / photo (`decideFacility`,`decidePhoto`) | ambassador+ | `/admin/moderation` | 1 | EXPOSED |
| Resolve report (`resolveReport`) | ambassador+ | `/admin/moderation` | 1 | EXPOSED |
| Verify deck (`VerifyDeck` / `saveFacility`) | ambassador+ | `/admin/verify` · *Проверка* | 1 | EXPOSED |
| Edit facility (`saveFacility`) | admin | `/admin/facilities/[id]` | 2 | EXPOSED |
| OSM import trigger (`enqueueImport`) | admin | `/admin/import` · dry-run / live | 1 | EXPOSED — *no confirm / no worker status* |
| Municipal CSV import (`parse/preview/commitCsv`,`addMunicipality`) | admin | `/admin/obshtini` | 1 | EXPOSED |
| Bulk-create sessions (`createGridAction`) | admin | `/admin/sesii` · *Тренировки* | 1 | EXPOSED |
| Results (`save/parse/preview/commit ResultsCsv`,`saveResults`) | admin | `/admin/rezultati` | 1 | EXPOSED |
| Campaign CRUD (`create/update/publish/close/cancel Campaign`) | admin | `/admin/kampanii` | 1 | EXPOSED |
| Ambassadors + municipalities (`grant/revokeAmbassador`,`add/removeMunicipality`) | admin | `/admin/ambasadori` | 1 | EXPOSED |
| Reports (`/api/admin/otcheti`) | admin | `/admin/otcheti` · *Отчети* | 1 | EXPOSED |

## Proposed fixes for BURIED / ORPHANED

Intentional orphans need no fix: `confirmUnsubscribe` (email-only), `redeemCheckin`
(scan at venue), `/api/widget` (external embed). The rest:

1. **Add a global footer** (persistent, every page). Position: below the app shell /
   above the mobile tab bar. Labels: **Статистика** (`/statistika`), **Отворени данни**
   (`/danni`), **Отчетност** (`/obshtina` index), **Поверителност** (`/privacy`), plus
   ODbL/OSM attribution. Why: these are the transparency surfaces a public-money NGO must
   keep one tap away; today they're findable only by search. Fixes 4 BURIED rows at once.
2. **Sessions surface.** Fix the *Сесии* tab to point at a real sessions/weekly index
   (not `/kampanii`); add a public sessions browse (by city / near-me / sport) so RSVP,
   reminders and QR stop being stranded. Interim: link `/sedmitsata/[my city]` from the
   tab. Position: the second tab-bar slot (already labelled *Сесии*).
3. **API keys.** Surface *Отворени данни → ключове* from `/profil` (a developer row) so
   `createApiKey`/`revokeApiKey` are reachable without knowing the `/danni/klyuchove` URL.
4. **Accountability from the map.** On a facility's municipality (facility detail or the
   city SEO page), a link *Отчетност на общината* → `/obshtina/[city]` — already present on
   SEO pages; add it to `/obekt` and the footer so it isn't SEO-only.
5. **`/kampanii` needs a nav home** distinct from Сесии — either its own tab/entry
   ("Кампании") or fold under a "Играй" section once sessions exist.
