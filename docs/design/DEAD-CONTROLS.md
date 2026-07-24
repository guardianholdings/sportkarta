# Dead / broken controls

Every interactive element checked by driving the running app plus a source sweep.
Severity by user impact. Screenshots in `docs/design/audit/`.

## P1 — broken, misleading, or fires with no feedback

1. **Locate — *Намери ме* — occluded by the bottom sheet (mobile).** The floating
   control at `bottom-[168px]` is covered by the sheet at the half/full snaps; the top
   element at its centre is a result-card `<span>`. Tapping it (ref-reachable) produced
   **no visible change and no locating/error state**. So on a phone it both can't be hit
   and gives no feedback when it is. — `components/map/map-explorer.tsx`, the floating
   `IconButton` "Намери ме". *(also UX Flow 1)*
2. **"Жив импорт" — destructive, no confirmation.** `/admin/import` fires `enqueueImport`
   for a live OSM re-import (overwrites osm-set fields across thousands of rows) on a
   single tap, no confirm. — `app/[locale]/admin/(protected)/import/*`.
3. **Import — silent no-op when the worker is down.** The button enqueues a pg-boss job;
   if the worker isn't running the job never executes and nothing is surfaced
   ("Последни изпълнения" stays empty). A control that "fires with no feedback." —
   same file. *Fix:* worker/queue-health indicator + job state polling.
4. **"Сесии" tab → `/kampanii`.** Not a 404, but the control's label (Sessions) doesn't
   match its destination (Campaigns — currently empty). A member tapping *Сесии* lands on
   an empty *Кампании* page. — `map-explorer.tsx` `NAV[navSessions].href`.
5. **"предложи своя тренировка" — invitation with no affordance.** The weekly page's copy
   invites a member to propose a session, but there is no control to do it (member
   organizer tools are Stage 4.3, unbuilt). Dead-end promise. —
   `app/[locale]/sedmitsata/[city]/page.tsx`.

## P2 — safe but rough

6. **"Няма го" (moderation → mark facility `gone`) — no confirmation or undo.** A
   consequential decision on one tap, in a fast-clearing UI. Prefer an **undo** toast over
   silent commit. — `app/[locale]/admin/(protected)/moderation/*`.
7. **Some map list/chip buttons surface with no accessible name.** In the a11y snapshot of
   `/`, 5 buttons (result cards / off-screen chips) appeared nameless. The `ResultCard`
   `<button>` should expose its text as the accessible name — **investigate** whether the
   thumb/`min-w-0 truncate` structure or the icon-only chips are suppressing it, and add
   an `aria-label` where needed. — `map-explorer.tsx` `ResultCard`, `components/ui/chip.tsx`.
8. **SEO facility-card link text concatenates name + sport** ("Спортно съоръжениетенис")
   into one screen-reader token. — `app/[locale]/igrishta/[city]/*`. *Fix:* visually-hidden
   separator or `aria-label`.
9. **`components/admin/map-embed.tsx` contains a TODO** — confirm it isn't a stubbed
   control before shipping the admin surfaces.
10. **Native file inputs render "Choose File" (English)** on add-facility, condition and
    report. Browser-native, not localizable in place. — `add-facility-form.tsx`,
    `condition-form.tsx`, `report-form.tsx`. *Fix (optional):* proxy button → hidden input.
11. **Campaigns empty-state has no CTA** ("В момента няма обявени кампании.") — no broken
    control, but a screen with no forward path. — `app/[locale]/kampanii/page.tsx`.

## Checked — clean

- **No `onClick` on non-button elements.** The seed prototype's habit of putting handlers
  on `div`/`span`/`li` is **not inherited** — grep across `app` + `components` finds none.
  All interactive elements are `<button>` / `<a>` / form controls.
- **No links to non-existent routes.** Every internal `href` resolves (`/admin`, `/danni`,
  `/profil`, `/privacy`, `/pasport`, `/dobavi`, `/vhod`, `/klasirane`, `/kampanii`). The
  index-less routes (`/sedmitsata`, `/sesiya`, `/igrishta`, `/kalendar`, `/obekt`,
  `/obshtina`) are never linked without a required param → no 404s from in-app navigation.
- **No orphan-disabled buttons.** Every `disabled` is tied to `pending` / validity with a
  clear path to enabling.
- **No authorization leak.** The `/profil → /admin` link is wrapped in
  `canAccessAdminPanel(user.role)` (hidden from plain users); admin pages `requireRole`
  server-side. No control visible to a role not authorized to use it was found.
- **Destructive account delete is gated.** `/profil` *Изтрий профила ми* requires a typed
  `confirmation` input.

## Note

`/profil` and the whole `/admin/*` console are still on the pre-seed (neutral) styling —
out of the PART B scope but relevant here: their controls work, but they don't share the
redesigned app's tokens/affordances (raw green/red moderation buttons, wrapping text-nav).
