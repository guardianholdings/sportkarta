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

| Capability (fn / route)                                             | Roles     | Entry point — route · affordance (bg)             | Taps         | Status                                                         |
| ------------------------------------------------------------------- | --------- | ------------------------------------------------- | ------------ | -------------------------------------------------------------- |
| Map + facilities (`facilitiesGeoJSON`, `/api/facilities` GET)       | all       | `/` · _Карта_ tab                                 | 0            | EXPOSED                                                        |
| Filter facilities (sport/access/lighting/surface/near-me)           | all       | `/` · _Филтри_ + chips                            | 1–2          | EXPOSED                                                        |
| Search facilities                                                   | all       | `/` · search box                                  | 1            | EXPOSED — _client name match only; no server search_           |
| Facility detail (`getFacilityBySlug`)                               | all       | `/obekt/[slug]` · card/marker → _Виж детайли_     | 2–3          | EXPOSED                                                        |
| Directions                                                          | all       | `/obekt`, preview · _Упъти ме_                    | 1–2          | EXPOSED                                                        |
| Report problem (`submitReport`)                                     | anon+     | `/obekt` · _Съобщи проблем_                       | 3–4          | EXPOSED — buried in detail                                     |
| Verify facility (`verifyFacilityAction`)                            | user+     | `/obekt` · _Потвърди_                             | 3–4          | EXPOSED                                                        |
| Report condition (`reportConditionAction`)                          | user+     | `/obekt` · _Изпрати_                              | 3–4          | EXPOSED                                                        |
| Add facility (`addFacilityAction`)                                  | user+     | `/dobavi` · add-FAB / _Профил_                    | 1            | EXPOSED                                                        |
| Sign in / OTP (`signInAction`)                                      | anon      | `/vhod` · _Профил_ tab (logged out)               | 1            | EXPOSED                                                        |
| Google sign-in (`googleSignInAction`)                               | anon      | `/vhod`                                           | 1            | EXPOSED — _ships off (`AUTH_GOOGLE_ENABLED`)_                  |
| Sign out (`signOutAction`)                                          | user+     | `/profil`,`/admin` · _Изход_                      | 1            | EXPOSED                                                        |
| Update profile (`updateProfileAction`)                              | user+     | `/profil` · _Запази_                              | 1            | EXPOSED                                                        |
| Delete account (`deleteAccountAction`)                              | user+     | `/profil` · _Изтрий профила ми_ (type-to-confirm) | 1            | EXPOSED — gated                                                |
| Rotate calendar token (`calendarTokenAction`)                       | user+     | `/profil` · _Смени адреса_                        | 1            | EXPOSED                                                        |
| iCal feed (`/kalendar/[token]`)                                     | token     | `/profil` calendar panel                          | 1            | EXPOSED                                                        |
| Digest subscribe (`setDigestSubscriptionAction`)                    | user+     | `/profil` · digest panel                          | 1            | EXPOSED                                                        |
| Digest unsubscribe (`confirmUnsubscribeAction`)                     | token     | `/sedmitsata/otpisvane/[token]`                   | email        | **ORPHANED in-app** (by design)                                |
| Passport + badges (view)                                            | user+     | `/pasport` · _Профил → Спортен паспорт_           | 2            | EXPOSED                                                        |
| Passport visibility (`setPassportVisibilityAction`)                 | user+     | `/pasport` · _Направи публичен_                   | 2            | EXPOSED                                                        |
| Acknowledge badges (`acknowledgeBadgesAction`)                      | user+     | `/pasport` (implicit on view)                     | —            | EXPOSED (implicit)                                             |
| Leaderboard                                                         | all       | `/klasirane` · _Класации_ tab                     | 0–1          | EXPOSED                                                        |
| Sessions index (`listUpcomingSessions`)                             | all       | `/sesii` · _Сесии_ tab                            | 0            | EXPOSED — _lists upcoming public occurrences_                  |
| RSVP / withdraw (`rsvpAction`,`withdrawAction`)                     | user+     | `/sesiya/[occurrenceId]` · via `/sesii`           | 2–3          | EXPOSED — _reachable now that /sesii lists them_               |
| QR check-in (`redeemCheckinAction`, `/otmetka/[token]`)             | user+     | scan the organiser's QR                           | QR           | **ORPHANED in-app** (by design — scan at venue)                |
| Campaigns (list / detail / results)                                 | all       | `/kampanii`,`/kampanii/[slug]`                    | URL          | **BURIED** — no nav entry (the Сесии tab now goes to `/sesii`) |
| Weekly city page                                                    | all       | `/sedmitsata/[city]`                              | email/SEO    | **BURIED** — no nav                                            |
| Accountability (`/obshtina/[city]`)                                 | all       | linked from SEO `/igrishta/[city]`                | 1 (from SEO) | **BURIED** — no nav (footer can't link an index-less route)    |
| Public statistics (`/statistika`, `/api/stats` GET)                 | all       | footer · _Статистика_                             | 1            | EXPOSED — _via the new footer_                                 |
| Open-data portal (`/danni`)                                         | all       | footer · _Отворени данни_                         | 1            | EXPOSED — _via the new footer_                                 |
| Create / revoke API key (`createApiKeyAction`,`revokeApiKeyAction`) | user+     | `/danni/klyuchove` (footer → `/danni` → ключове)  | 2            | EXPOSED                                                        |
| Open-data API + dumps (`/api/opendata/*` GET)                       | all / key | `/danni` docs + API                               | 1 / API      | EXPOSED                                                        |
| Embeddable widget (`/api/widget/obshtina/[city]` GET)               | all       | external embed                                    | —            | **ORPHANED in-app** (by design)                                |
| Grant reports export (`/api/admin/otcheti` GET)                     | admin     | `/admin/otcheti`                                  | 1            | EXPOSED                                                        |
| Privacy (`/privacy`)                                                | all       | footer + `/profil` + report form                  | 1            | EXPOSED                                                        |

## Admin / ambassador

| Capability                                                                       | Roles            | Entry point                                                | Taps | Status  |
| -------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------- | ---- | ------- |
| Admin hub (`/admin`)                                                             | ambassador/admin | `/profil` · _Админ панел_ (role-gated link)                | 1    | EXPOSED |
| Moderate facility / photo (`decideFacility`,`decidePhoto`)                       | ambassador+      | `/admin/moderation`                                        | 1    | EXPOSED |
| Resolve report (`resolveReport`)                                                 | ambassador+      | `/admin/moderation`                                        | 1    | EXPOSED |
| Verify deck (`VerifyDeck` / `saveFacility`)                                      | ambassador+      | `/admin/verify` · _Проверка_ / _Провери следващите →_      | 1    | EXPOSED |
| Edit facility (`saveFacility`)                                                   | admin            | `/admin/facilities/[id]`                                   | 2    | EXPOSED |
| OSM import trigger (`enqueueImport` → pg-boss)                                   | admin            | `/admin/import` · _Пробен импорт_ / _Жив импорт_ (confirm) | 1    | EXPOSED |
| Municipal CSV import (`parse/preview/commitCsv`,`addMunicipality`)               | admin            | `/admin/obshtini`                                          | 1    | EXPOSED |
| Bulk-create sessions (`createGridAction` → pg-boss materialize)                  | admin            | `/admin/sesii` · _Тренировки_                              | 1    | EXPOSED |
| Results (`save/parse/preview/commit ResultsCsv`,`saveResults`)                   | admin            | `/admin/rezultati`                                         | 1    | EXPOSED |
| Campaign CRUD (`create/update/publish/close/cancel Campaign`)                    | admin            | `/admin/kampanii`,`/admin/kampanii/[slug]`                 | 1–2  | EXPOSED |
| Ambassadors + municipalities (`grant/revokeAmbassador`,`add/removeMunicipality`) | admin            | `/admin/ambasadori`                                        | 1    | EXPOSED |

pg-boss job triggers reachable from the UI: **`import.osm`** (`/admin/import`),
**session materialize** (`/admin/sesii` → `boss.send`), **`session.notify`**
(`/sesiya/[occurrenceId]` RSVP/withdraw). All three have a control. No UI-callable
job is un-triggered.

## Proposed placement for BURIED / ORPHANED

Intentional orphans need no fix: `confirmUnsubscribe` (email-only),
`redeemCheckin` (scan at venue), `/api/widget` (external embed).

1. **Campaigns** lost its only nav entry when the _Сесии_ tab was corrected to
   `/sesii`. Give `/kampanii` its own home: a **"Кампании" card on `/sesii`** (or
   a sub-tab), position it under the sessions list, label _Кампании_ — the two
   are the "play/compete" pair and belong on one surface.
2. **Accountability (`/obshtina/[city]`)** is SEO-only because there is no
   `/obshtina` index to link. Add a minimal **`/obshtina` municipality picker**
   and a footer link _Отчетност_; also surface _Отчетност на общината_ on
   `/obekt` next to the municipality. Position: footer + facility detail.
3. **Weekly city page (`/sedmitsata/[city]`)** is a per-city digest with no
   index. Link _Тази седмица_ from the `/sesii` header (member's home city, or a
   city picker) so the digest is reachable without the email.
