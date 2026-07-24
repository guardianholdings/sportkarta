# Coverage matrix — capability ↔ control

Direction A of the bidirectional audit. Every capability in the codebase
(server actions, API route handlers, pg-boss job triggers, admin operations,
exports, role-gated abilities) inventoried from source, then mapped to its UI
entry point and verified by driving the running app per role. Reflects the
**current** state (after the `/sesii`, footer and locate fixes in `00707c1`).

"Taps" = from the relevant landing surface for the role (public: the map `/`;
member: `/profil`; admin: `/admin`). Status:

- **EXPOSED** — a role can reach it on a sane path.
- **BURIED** — callable, has a UI, but unreachable within a sane path for its
  role (no nav link; URL / SEO / email only).
- **ORPHANED** — callable with **no UI at all**, or the in-app UI is impossible
  by design.

Role gates counted in source: `requireRole('admin')` ×42, `requireAdmin()`
(ambassador **or** admin) ×20, `requireUser()` ×22, `canAccessAdminPanel` ×3.

## Public / member

| Capability (fn / route) | Roles | Entry point — route · affordance (bg) | Taps | Status |
|---|---|---|---|---|
| Map + facilities (`facilitiesGeoJSON`, `/api/facilities` GET) | all | `/` · *Карта* tab | 0 | EXPOSED |
| Filter facilities (sport/access/lighting/surface/near-me) | all | `/` · *Филтри* + chips | 1–2 | EXPOSED |
| Search facilities | all | `/` · search box | 1 | EXPOSED — *client name match only; no server search* |
| Facility detail (`getFacilityBySlug`) | all | `/obekt/[slug]` · card/marker → *Виж детайли* | 2–3 | EXPOSED |
| Directions | all | `/obekt`, preview · *Упъти ме* | 1–2 | EXPOSED |
| Report problem (`submitReport`) | anon+ | `/obekt` · *Съобщи проблем* | 3–4 | EXPOSED — buried in detail |
| Verify facility (`verifyFacilityAction`) | user+ | `/obekt` · *Потвърди* | 3–4 | EXPOSED |
| Report condition (`reportConditionAction`) | user+ | `/obekt` · *Изпрати* | 3–4 | EXPOSED |
| Add facility (`addFacilityAction`) | user+ | `/dobavi` · add-FAB / *Профил* | 1 | EXPOSED |
| Sign in / OTP (`signInAction`) | anon | `/vhod` · *Профил* tab (logged out) | 1 | EXPOSED |
| Google sign-in (`googleSignInAction`) | anon | `/vhod` | 1 | EXPOSED — *ships off (`AUTH_GOOGLE_ENABLED`)* |
| Sign out (`signOutAction`) | user+ | `/profil`,`/admin` · *Изход* | 1 | EXPOSED |
| Update profile (`updateProfileAction`) | user+ | `/profil` · *Запази* | 1 | EXPOSED |
| Delete account (`deleteAccountAction`) | user+ | `/profil` · *Изтрий профила ми* (type-to-confirm) | 1 | EXPOSED — gated |
| Rotate calendar token (`calendarTokenAction`) | user+ | `/profil` · *Смени адреса* | 1 | EXPOSED |
| iCal feed (`/kalendar/[token]`) | token | `/profil` calendar panel | 1 | EXPOSED |
| Digest subscribe (`setDigestSubscriptionAction`) | user+ | `/profil` · digest panel | 1 | EXPOSED |
| Digest unsubscribe (`confirmUnsubscribeAction`) | token | `/sedmitsata/otpisvane/[token]` | email | **ORPHANED in-app** (by design) |
| Passport + badges (view) | user+ | `/pasport` · *Профил → Спортен паспорт* | 2 | EXPOSED |
| Passport visibility (`setPassportVisibilityAction`) | user+ | `/pasport` · *Направи публичен* | 2 | EXPOSED |
| Acknowledge badges (`acknowledgeBadgesAction`) | user+ | `/pasport` (implicit on view) | — | EXPOSED (implicit) |
| Leaderboard | all | `/klasirane` · *Класации* tab | 0–1 | EXPOSED |
| Sessions index (`listUpcomingSessions`) | all | `/sesii` · *Сесии* tab | 0 | EXPOSED — *lists upcoming public occurrences* |
| RSVP / withdraw (`rsvpAction`,`withdrawAction`) | user+ | `/sesiya/[occurrenceId]` · via `/sesii` | 2–3 | EXPOSED — *reachable now that /sesii lists them* |
| QR check-in (`redeemCheckinAction`, `/otmetka/[token]`) | user+ | scan the organiser's QR | QR | **ORPHANED in-app** (by design — scan at venue) |
| Campaigns (list / detail / results) | all | `/kampanii`,`/kampanii/[slug]` | URL | **BURIED** — no nav entry (the Сесии tab now goes to `/sesii`) |
| Weekly city page | all | `/sedmitsata/[city]` | email/SEO | **BURIED** — no nav |
| Accountability (`/obshtina/[city]`) | all | linked from SEO `/igrishta/[city]` | 1 (from SEO) | **BURIED** — no nav (footer can't link an index-less route) |
| Public statistics (`/statistika`, `/api/stats` GET) | all | footer · *Статистика* | 1 | EXPOSED — *via the new footer* |
| Open-data portal (`/danni`) | all | footer · *Отворени данни* | 1 | EXPOSED — *via the new footer* |
| Create / revoke API key (`createApiKeyAction`,`revokeApiKeyAction`) | user+ | `/danni/klyuchove` (footer → `/danni` → ключове) | 2 | EXPOSED |
| Open-data API + dumps (`/api/opendata/*` GET) | all / key | `/danni` docs + API | 1 / API | EXPOSED |
| Embeddable widget (`/api/widget/obshtina/[city]` GET) | all | external embed | — | **ORPHANED in-app** (by design) |
| Grant reports export (`/api/admin/otcheti` GET) | admin | `/admin/otcheti` | 1 | EXPOSED |
| Privacy (`/privacy`) | all | footer + `/profil` + report form | 1 | EXPOSED |

## Admin / ambassador

| Capability | Roles | Entry point | Taps | Status |
|---|---|---|---|---|
| Admin hub (`/admin`) | ambassador/admin | `/profil` · *Админ панел* (role-gated link) | 1 | EXPOSED |
| Moderate facility / photo (`decideFacility`,`decidePhoto`) | ambassador+ | `/admin/moderation` | 1 | EXPOSED |
| Resolve report (`resolveReport`) | ambassador+ | `/admin/moderation` | 1 | EXPOSED |
| Verify deck (`VerifyDeck` / `saveFacility`) | ambassador+ | `/admin/verify` · *Проверка* / *Провери следващите →* | 1 | EXPOSED |
| Edit facility (`saveFacility`) | admin | `/admin/facilities/[id]` | 2 | EXPOSED |
| OSM import trigger (`enqueueImport` → pg-boss) | admin | `/admin/import` · *Пробен импорт* / *Жив импорт* (confirm) | 1 | EXPOSED |
| Municipal CSV import (`parse/preview/commitCsv`,`addMunicipality`) | admin | `/admin/obshtini` | 1 | EXPOSED |
| Bulk-create sessions (`createGridAction` → pg-boss materialize) | admin | `/admin/sesii` · *Тренировки* | 1 | EXPOSED |
| Results (`save/parse/preview/commit ResultsCsv`,`saveResults`) | admin | `/admin/rezultati` | 1 | EXPOSED |
| Campaign CRUD (`create/update/publish/close/cancel Campaign`) | admin | `/admin/kampanii`,`/admin/kampanii/[slug]` | 1–2 | EXPOSED |
| Ambassadors + municipalities (`grant/revokeAmbassador`,`add/removeMunicipality`) | admin | `/admin/ambasadori` | 1 | EXPOSED |

pg-boss job triggers reachable from the UI: **`import.osm`** (`/admin/import`),
**session materialize** (`/admin/sesii` → `boss.send`), **`session.notify`**
(`/sesiya/[occurrenceId]` RSVP/withdraw). All three have a control. No UI-callable
job is un-triggered.

## Proposed placement for BURIED / ORPHANED

Intentional orphans need no fix: `confirmUnsubscribe` (email-only),
`redeemCheckin` (scan at venue), `/api/widget` (external embed).

1. **Campaigns** lost its only nav entry when the *Сесии* tab was corrected to
   `/sesii`. Give `/kampanii` its own home: a **"Кампании" card on `/sesii`** (or
   a sub-tab), position it under the sessions list, label *Кампании* — the two
   are the "play/compete" pair and belong on one surface.
2. **Accountability (`/obshtina/[city]`)** is SEO-only because there is no
   `/obshtina` index to link. Add a minimal **`/obshtina` municipality picker**
   and a footer link *Отчетност*; also surface *Отчетност на общината* on
   `/obekt` next to the municipality. Position: footer + facility detail.
3. **Weekly city page (`/sedmitsata/[city]`)** is a per-city digest with no
   index. Link *Тази седмица* from the `/sesii` header (member's home city, or a
   city picker) so the digest is reachable without the email.
