# Dead / broken controls

Direction B of the bidirectional audit. Every interactive element inventoried
from source, then **driven per role** (anonymous / member / admin) by the
Playwright crawler (`e2e/crawl.spec.ts`, all three green) plus targeted manual
driving. Reflects the current state after the `00707c1` fixes and this pass's
control fixes (below). Severity by user impact.

## Corrections to the first audit (verified this pass)

The first pass made two wrong calls on `/admin/import`, both fixed here by
reading the code and driving:

- **"Жив импорт" (live import) DOES confirm** — it is a `ConfirmButton`
  (`window.confirm(t('liveConfirm'))` → `preventDefault` on cancel). The prior
  "no confirmation" was wrong.
- **Import DOES give feedback** — after enqueue the page shows _`?enqueued`_ (a
  green "queued" message) or _`?conflict`_ ("already queued"). The prior "silent
  no-op" was wrong; the real gap is worker-health visibility (below, P2).

Also already fixed in `00707c1`: the occluded locate control (repositioned
top-right, verified un-occluded), the _Сесии_ → empty-Campaigns mislabel (now
`/sesii`), and the dead "предложи тренировка" weekly copy (reworded).

## Fixed this pass

1. **Campaign create/edit form crashed on render (P1, was undetected).**
   `campaign-form.tsx` built its scoring checkboxes from `PASSPORT_EVENT_KINDS`,
   which includes `session_attended` — a kind that exists only to type the badge
   event stream and has no `event_session_attended` label. Rendering
   `/admin/kampanii/nova` (or any campaign edit) threw `MISSING_MESSAGE`; being a
   client-component throw, the form never drew. The key is absent in **both**
   locales, so the i18n parity test could not catch it. _Fix:_ a new
   `CAMPAIGN_EVENT_KINDS` (`lib/src/campaigns/rules.ts`) = the passport kinds
   minus `session_attended`; the form renders it and `validateCampaignRules` now
   refuses it — the same call badges already make (a QR check-in scores once as
   `session_checkin`; counting the ledger payment too would count one evening
   twice). Verified: the form draws with its four valid event boxes, no console
   error.
2. **Destructive-confirmation policy — now one policy.** The four one-click ops
   below share a single `ConfirmButton` (`components/ui/confirm-button.tsx`,
   promoted out of the import page): `window.confirm` on click, `preventDefault`
   on cancel, re-authorized server-side regardless.
   - **Revoke ambassador** (`ambasadori/page.tsx`) — the message names them.
   - **Remove a municipality from an ambassador** (`ambasadori/page.tsx`).
   - **Cancel a campaign** (`kampanii/[slug]/page.tsx`).
   - **"Няма го"** (moderation → mark facility `gone`) (`moderation/page.tsx`).
     Type-to-confirm (campaign close, account delete) is unchanged — it stays the
     guard for the irreversible ones. Verified by driving: cancelling the revoke
     dialog leaves the row untouched and fires no action.
3. **SEO facility-card accessible name.** `components/places/facility-list.tsx`
   now gives each `/obekt/[slug]` link an explicit `aria-label`
   (`<name> — <sport, sport>`), so a screen reader hears name and sports as
   distinct tokens instead of the flattened "Спортно съоръжениетенис". Verified
   on `/igrishta/sofia`.

## Still open

- **Import — no worker-health / job-processing signal.** Enqueue feedback and
  the live confirm exist, but nothing shows the worker is up; a job queued with
  the worker down never runs and the only tell is the empty "Последни
  изпълнения" list. — `/admin/import`. A worker/queue-health surface plus
  per-job state (queued/running/failed) — a feature, not a one-line fix.
- **Native file inputs read "Choose File" (English)** on add-facility,
  condition and report; the surrounding label/hint are Bulgarian. Cosmetic
  i18n. _Fix (optional):_ a button proxying a hidden `<input type=file>`.
- **"Направи публичен" (passport visibility)** publishes a member's activity on
  one tap, no confirm — left as-is deliberately: it is reversible and the state
  flip is its own feedback, so a confirm would only add friction to a safe
  toggle. Reconsider only if publishing proves to surprise members. — `/pasport`.

## Checked — clean (driven per role)

- **No `onclick` on non-button/link elements.** The seed prototype's habit of
  handlers on `div`/`span` is **not inherited** — the crawler's `[onclick]`
  probe found zero across every page for every role, and a source grep agrees.
  All interactive elements are `<button>` / `<a>` / form controls.
- **No dead links / 404s.** The per-role crawler follows every internal link
  **with that role's session** and found zero 404/5xx across anonymous, member
  and admin.
- **No links that navigate nowhere.** No `<a>` with empty / `#` / `javascript:`
  href (skip-to-content anchors carry a target and are legitimate).
- **No authorization leak.** The crawler's authz probe drove an anonymous
  visitor (denied every member + admin route) and a plain member (denied every
  admin route) — each protected route redirected to sign-in, none rendered. The
  `/profil → /admin` link is `canAccessAdminPanel(user.role)`-gated (hidden from
  plain members); admin actions `requireRole('admin')` / `requireAdmin()`
  server-side.
- **Mutations give feedback.** Member/admin forms use `useActionState` and render
  success/error (add-facility, condition, verify, check-in, profile, RSVP,
  sign-in, grant-ambassador, campaign, results, municipal import, bulk sessions).
  Moderation decisions feed back by the item leaving the queue (revalidation).
- **No orphan-disabled buttons.** Every `disabled` is tied to `pending` /
  validity, with a path to enabling.

## Regression suite

`e2e/crawl.spec.ts` — three role crawls (anonymous / member / admin) that fail on
404 pages, dead internal links, links that navigate nowhere, `onclick` on
non-button/link elements, **and authorization leaks** (a role reaching a route
above its privilege). It fetches with each role's session, and is resilient to
Next dev's on-demand compilation (retries transient errors, trusts only a
definitive HTTP status). Runs under `pnpm test:e2e`, already in CI. Currently
green for all three roles.
