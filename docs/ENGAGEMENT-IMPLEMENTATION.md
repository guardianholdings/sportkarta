# SportKarta — Engagement & Sharing: Implementation Plan (v1, 2026-07-26)

Companion to `docs/ENGAGEMENT.md` (the proposal). That document says **what** to
build and why; this one says **where in this repo it goes**, in what order, and
what it will break on the way.

Produced by a six-workstream pass over the codebase (Tier A surfacing, Tier B
competition, Tier C sharing, design system, data/jobs, guardrails/i18n/tests),
each spec adversarially verified against the actual files. Every workstream came
back `NEEDS_FIXES`; the fixes are folded in below.

**Confidence note.** Facts marked ✔ were verified directly during planning
(journal state, view definition, gate scopes, `next/og` presence, prod compose
env, mail transport resolution). Everything else is a `file:line` claim checked
by a second agent against the tree — accurate at time of writing, worth
re-confirming before you edit the file.

---

## Status log

| Phase | State | Notes |
|---|---|---|
| 0 — Truth repairs | ✅ **done 2026-07-26** | All five items, each with a gate proven to fail on the bug it guards. |
| 1 — Show the number (A2) | ✅ **done 2026-07-26** | Verified in-browser (bg + en) and by the QR + contributions e2e suites. |
| 2 — Instrument + framing rule (C1, C7) | ✅ **done 2026-07-26** | 9 events across 8 files, closed vocabulary, privacy copy updated. |
| 3 — Badge evaluation off the render path (A1) | ✅ **done 2026-07-26** | **No migration needed.** Verified end-to-end against the real worker + database. |
| 4 — Streak freezes + at-risk (A4) | 🟡 **engine + schema done 2026-07-26** | Pure fold and migration `0025` landed and applied. **Granting job, read wiring and UI still to do.** |
| 5 onward | not started | |

### Phase 4, so far

**The pure engine is done and is the hard part.** `streakBuckets`/`summarizeStreak`
take an optional set of frozen week keys, and `StreakSummary` gained `atRisk`.
Three decisions, each now enforced rather than documented:

- **A frozen week BRIDGES but does not COUNT.** Two active weeks with a frozen gap
  is a streak of *two*, not three. A freeze forgives a week you missed; it must
  never manufacture one you did not show up for, which is the opposite of the
  product's whole framing.
- **Weeks only, by CHECK.** A day-streak freeze would be the daily loss-pressure
  loop §3 rejects outright. `streak_freezes_week_only` means a caller cannot
  widen the mechanic by passing a different string.
- **A cap, not a balance.** CLAUDE.md fixes the economy as earning-only with no
  spending mechanics, so a freeze cannot be a currency the member holds and
  spends. It is forgiveness the system applies, capped per rolling year. The copy
  must say *applied*, never *used up*.

`bridged()` generalises the old adjacency test — with an empty freeze set it is
the identical function, which is why the DST suite still passes unchanged and is
still testing what it always tested.

**Migration `0025` went through `db-migration-reviewer` and came back with four
blocking findings, all fixed and re-verified against the live database:**

1. `extract(isodow from 'infinity'::date)` is **NULL** since PG14, and `NULL = 1`
   is NULL — which a CHECK *accepts*. An infinite key would have sat in the table
   forever, matched no key the fold looks up (so the freeze silently does
   nothing) and still consumed one of the year's allowance. Fixed with an
   `isfinite()` guard; rejection confirmed in psql.
2. No `lock_timeout`/`statement_timeout` guards, while the FK takes SHARE ROW
   EXCLUSIVE on `users` — a deploy landing mid-transaction would have queued
   every write to `users` indefinitely. Guards added and the FK moved last.
3. No `-- rollback:` note. Added.
4. **My header cited the wrong precedent.** I wrote that `user_badges` has no
   `account_deletions` counter; it does (`badges_erased`, 0010). The schema's only
   genuinely uncounted user-scoped cascade is `calendar_tokens`. The decision to
   omit a counter stands; the justification was corrected.

Also dropped a redundant `(user_id)` index — a strict prefix of the unique index,
which would have cost an extra index on every insert *and* forced a heap fetch on
the one read path it claimed to serve.

**Still to do in Phase 4:** the granting job (which applies a freeze within the
rolling-year cap), the `frozenWeeks` reader wiring into `ownPassport`, and the
StreakPanel at-risk/frozen states (D3). Until the granting job exists the table
is never written, so the mechanic is inert — the engine is correct but nothing
triggers it yet.

**Still deliberately not built:** the at-risk *nudge mail*. It needs the
frequency cap and its own unsubscribe route, neither of which is decided. The
at-risk *state* is now computed, so it can be surfaced in-app with no mail at all.

**Phase 3 came in smaller than planned: no migration at all.** The plan budgeted
`0025` for a shared notification ledger, but `user_badges` already carries
`seen_at`/`first_seen_at`, and the ledger is only needed by the MAIL layer —
which is still blocked on the frequency-cap and unsubscribe decisions. So A1
shipped as pure code: `recordEarnedBadges` gained a cutoff, a `passport.evaluate`
job, a `badges.backfill` one-shot, and five enqueue call sites. `0025` moves to
whenever mail actually ships.

**The backfill is silent by a cutoff, not a flag** (operator decision
2026-07-26). `RecordBadgesOptions.unseenSince` means "a badge is new only if it
was earned just now"; anything older is written already-seen. A `silent: boolean`
would have made the backfill and the live path two different code paths, and then
the ORDER between them matters — a contribution arriving before the backfill
reached that member would still produce the burst. As a cutoff, both paths are
the same call and the race cannot exist. Proven on one member in one call: a
badge earned 120 days ago stayed silent while `mapper_5`, earned in the same
evaluation, lit up.

**Verified end-to-end, not just by unit test.** The worker was run against the
dev database with a purpose-built fixture: `badges.backfill` evaluated 9 members
and recorded 1 badge, silently; `passport.evaluate` then recorded a
just-earned badge as unseen. Fixture removed afterwards, dev data unchanged.

Two things worth knowing for phase 4+:

- **`evaluateAndRecordBadges` lives in `db/src/passport.ts`, not `apps/web/lib`** —
  the worker cannot import `apps/web`, the same reason `weeklyDigest` lives in
  `db/`. One implementation, so the job and `/pasport` cannot disagree about who
  holds which badge.
- **The enqueue can never break a write.** `enqueuePassportEvaluate` swallows
  every failure, and `apps/web/tests/passport-evaluate.test.ts` pins it — the
  plan listed this as a risk bullet; it is a deliverable. Inside `checkIn` a
  throwing enqueue would contradict the rule the anti-abuse layer rests on:
  attendance is a fact and is always recorded, only the payment stops.

Still deliberately **not** built: any mail. The job records and marks; it sends
nothing, because a notifier without a frequency cap is how a member gets four
engagement emails in one weekend.

**Phase 2 checkpoint:** typecheck green, lint clean, **1,505 unit tests**
(web 41 files / 488 tests), and `contributions` + `checkin-qr` + `sessions-rsvp`
e2e green (16 passed, 1 skipped). Attributes confirmed in the served HTML; the
privacy section verified rendering in both locales.

**What C1 collects, and what it deliberately does not.** Nine click-tracked
events (`lib/analytics-events.ts`), each naming a SURFACE and an ACTION and
never a subject — no facility slug, no occurrence id, no handle. Two decisions
worth knowing:

- **`checkin_submit` carries no outcome dimension.** `unscored_out_of_range` and
  `unscored_daily_cap` would record that a particular person checked in from too
  far away, or has already hit today's cap — a behavioural record about an
  individual rather than a product metric. The event records only that a
  check-in was attempted.
- **No `data-umami-event-*` dimension attributes at all.** That is the channel an
  id or an outcome would travel through, so the gate forbids the whole shape
  rather than policing values inside it.

`Privacy.analyticsBody` was updated in the same commit, in both catalogues, to
say plainly that action *kinds* are now recorded and that they carry no
identifier of person, facility, session or check-in. **That copy is a published
promise and should be read by the operator before deploy.**

The gate (`tests/analytics-events.test.ts`) found a hole in itself during
development: it scanned line-by-line, so the RSVP button's multi-line ternary —
the shape prettier produces automatically — escaped the vocabulary check
entirely. That is exactly how `data-umami-event={\n  \`facility_${slug}\`\n}`
would have slipped through. It now scans whole-file, and all three exfiltration
shapes (inline template literal, multi-line template literal, dimension
attribute) are proven to fail it.

C7 is enforced by `tests/framing.test.ts` against a reasoned denylist in
`lib/framing-denylist.json` (JSON, not TypeScript — a Bulgarian denylist in a
`.ts` would be flagged by the hardcoded-Cyrillic gate beside it). Calibration
against the live catalogue caught a naive substring match firing on **"елит"
inside "Сателитен изглед"**, so every token matches at a word boundary and that
regression has its own test. Scope is the achievement and share namespaces —
`Leaderboard` and `Campaign` are deliberately excluded, because a rank and a
named winner are facts on a ranking surface, and a gate forbidding them would be
wrong rather than strict. Five of the ten guarded namespaces do not exist yet;
listing them now is the point, since a framing rule is only cheap before the
copy is written.

**Verification at the Phase 1 checkpoint:** typecheck green across all 7 packages,
lint clean, **1,493 unit tests** passing (baseline was 1,469 — the delta is new
gates, no test was weakened), plus the QR check-in and contributions e2e suites.

Three things found during implementation that the plan above did not predict:

1. **The stale-minors copy was in THREE places, not two.** `AdminCampaigns.leaderboardIndividualNote`
   carried the same withdrawn claim on the admin campaign form. Also: the
   leaderboard and campaign notes needed *different* corrections, because the
   surfaces genuinely differ — `db/src/leaderboard.ts` inner-joins the eligibility
   view inside the ranking CTE (a private member gets no rank at all), while
   campaigns score everyone and gate only display. Writing "everyone's points
   count" on the leaderboard would have replaced one false promise with another.
2. **"lib/src and apps/worker/src are clean" was wrong.** `lib/src` has 313
   Cyrillic hits and `db/src` 97; only `apps/worker/src` is genuinely at zero. Nearly
   all are legitimate — Bulgarian test fixtures, a transliteration algorithm keyed
   on the letters it transliterates, a registry-parsing lexicon, and the ministry
   annex CLAUDE.md deliberately keeps out of i18n. The gate therefore scopes to
   non-test files with four justified, self-auditing exclusions rather than the
   empty allowlist the plan assumed.
3. **`e2e/contributions.spec.ts` asserted `/\?added=1/` unanchored**, so it matched
   `?added=10` and would have passed without testing anything. Now anchored to
   `POINTS_BY_EVENT.facility_added` and paired with an assertion on the visible
   banner text.

### A separate, pre-existing problem: the e2e suite is not reliable in full

Run individually, every suite passes — `checkin-qr` 4/5 (1 skipped),
`contributions` 7/7, `auth-otp` 10/10, `admin-verify` 5/5. Run as one
`playwright test`, `auth-otp`, `admin-verify` and both `crawl` projects hit
retries, and the whole run takes **well over 15 minutes** against a dev server
compiling routes on demand (it blew through a 900s timeout).

Nothing here is caused by the Phase 0/1 changes — the two specs that failed
touch no code path they modified, and both pass clean in isolation. The likely
cause is shared state: one worker, one dev database, fixtures created per spec,
and HMR recompiles between them.

This matters for the rest of the plan, because almost every remaining phase
wants a new e2e assertion and there is currently no trustworthy full-suite
signal to add them to. Worth its own fix — per-spec database isolation or
serialisation of the fixture-creating specs — before Phase 6 onward leans on it.

Two concrete causes found, both cheap to fix:

- **The dev mail outbox is never pruned.** `apps/web/var/mail` had 497 files /
  1.9 MB accumulated since 2026-07-23, and `latestMessageFor` in `e2e/auth.ts`
  re-parses every one of them on each poll inside a 10-second budget. At the tail
  of a long run that is marginal, which is exactly where the admin crawl failed.
  (Don't just delete it — `/dev/poshta` reads that directory.)
- **A failed health check makes Playwright spawn a COMPETING dev server.**
  `webServer.reuseExistingServer` health-checks `http://localhost:3000`; if that
  check fails, Playwright starts its own `pnpm dev`, which lands on port 3003 but
  writes to the same `apps/web/.next`. Two dev servers on one `.next` is the
  concurrent-write race CLAUDE.md documents under `pnpm build`, reached by a
  different road — it left `/` returning 500 while every other route stayed 200,
  and `prerender-manifest.json` stayed valid JSON so the documented symptom never
  appeared. Recovery is the documented one: stop dev, confirm no `next dev` /
  `next-server` survives, `rm -rf apps/web/.next`, restart. **Check `/` returns
  200 before invoking Playwright**, or a transient 500 escalates into a corrupted
  build directory.

---

## 0. Phase 0 — five things that are wrong TODAY

None of this is engagement work. All of it is in the blast radius, and three
items are live defects that exist whether or not this plan ever ships.

### P0.1 — Production worker mail is dead ✔ (severity: high, pre-existing)

`deploy/compose.prod.yml:81-99` gives the worker exactly three environment
variables: `DATABASE_URL`, `STORAGE_DIR`, `OPENDATA_DUMP_RETENTION`. There is no
`env_file` and no YAML anchor. Meanwhile:

- `Dockerfile:41` sets `ENV NODE_ENV=production` on the worker stage.
- `resolveMailTransport` (`lib/src/email/mailer.ts:83`) returns
  `{kind:'disabled', reason:'SMTP_HOST is unset'}` when production and no SMTP.
- `DisabledMailer.send()` (`mailer.ts:100`) **rejects**.
- `apps/worker/src/index.ts:167,192,221` fall back to
  `siteUrl = 'http://localhost:3000'`.

So **session RSVP mail, T-24h/T-2h reminders and the Monday weekly digest all
fail to send in production today**, and would carry localhost links if they
didn't. Stage 4.2 and 4.4 are shipped features that do not work.

Fix: add `SMTP_HOST/PORT/USER/PASS/FROM` and `NEXT_PUBLIC_SITE_URL` to the
worker service, mirroring the web service block at `compose.prod.yml:28,43-47`.
This is a prerequisite for every mail-bearing item in this plan (A1, A3, A5, A7)
and it repairs two shipped stages on its own.

> Note for later: pg-boss schedules **persist in the database**. Turning a job
> off later needs `boss.unschedule`, not just removing the `boss.schedule` call.

### P0.2 — The site states a privacy rule that was withdrawn (severity: high)

`Leaderboard.eligibilityNote` and `Campaign.eligibilityNote` (both catalogues)
still tell members that under-18s are never shown publicly. Migration
`0020_minors_as_adults` made that false on 2026-07-25. `db/src/leaderboard-authz.test.ts:170`
actively asserts the opposite — a published minor appears at the top of every
board.

Rendered at `klasirane/page.tsx:183` and `kampanii/[slug]/page.tsx:172`. It is a
published promise the product already breaks, and A6 (unburying `/kampanii`)
would drive traffic straight at it.

Correct replacement framing — and note the two pages need **different** copy,
because the two surfaces behave differently:

- **Leaderboard**: appearing requires a public passport; age is not a condition.
  Stop there. Do *not* add "everyone's points count" — on the leaderboard they
  don't: `memberStanding` joins the eligibility view inside the ranking CTE and
  returns `null` for a private member (`leaderboard-authz.test.ts:197`).
- **Campaign**: scoring counts everyone, only display is gated. That sentence is
  true here and is why the key exists.

### P0.3 — A code comment now asserts the opposite of what we're about to do

`db/src/leaderboard.ts:29-31`: *"Check-ins are deliberately NOT ranked… until
Stage 4.3's signed QR exists."* That precondition has been met — the signed
expiring QR shipped in Stage 5.4, 4.3 completed 2026-07-25 — but the comment was
never amended. B1 (Local Legend) is the first feature to rank check-ins and must
amend that paragraph in the same commit.

### P0.4 — Widen the hardcoded-Cyrillic gate before any copy lands ✔

`apps/web/tests/i18n-hardcoded.test.ts:13-14` scans `apps/web/{app,components,lib}`
only — `WEB_ROOT = process.cwd()`. The workspace package at `/lib` (`lib/src/**`)
and `apps/worker/src/**` are scanned by nothing. `lib/src/reports/quarterly.ts:38`
already holds hardcoded Bulgarian with a green suite.

That matters *directly*: the streak-nudge email, the campaign-close email and
the Wordle-style share text are all natural residents of `lib/src` or
`apps/worker/src`. All three were verified clean of non-comment Cyrillic today,
so a second gate over those roots can ship now with a genuinely empty allowlist.
Ship it **before** the copy, not after.

### P0.5 — Pre-seed brand values never replaced

`app/[locale]/layout.tsx:22` `themeColor` and `app/manifest.ts:20` `theme_color`
are both `#0f766e` — a shadcn teal that appears nowhere in Trail & Summit.
`manifest.ts:19` `background_color: '#f6f5f2'` is a third stale value (`--paper`
is `#FBF9F3`). `RECONCILIATION.md` C6 called for this and it was never applied.

Every share preview that opens in an installed PWA shows teal chrome around a
pine-and-clay page. Neither file is inside the design-token gate's scanned dirs,
which is how it survived — so fix all three in one commit *and* add a drift test
parsing `app/design-tokens/colors.css`.

---

## 1. What changed since the proposal was written

`docs/ENGAGEMENT.md` was written on 2026-07-25, one day after migration 0020.
Its §4 guardrails section is its weakest part.

| Proposal says | Reality |
|---|---|
| §4: minors locked out by `users_minor_profile_not_public` CHECK + `is_minor = false` in the view | **Both removed by 0020.** The CHECK is dropped; the view's only predicates are `profile_visibility = 'public' AND public_handle IS NOT NULL` ✔. MUST-NEVER-BE-WIDENED survives but now guards **consent alone**. This is the single most load-bearing error in the document — all of Tier B was reasoned from it. |
| B3: "10 as the first rung for under-18s" | **Unbuildable, twice.** A predicate on `is_minor` is forbidden without an operator decision reversing 0020; and `BadgeDefinition` is `{slug, group, rule}` with no per-member variation anywhere in the engine. Ship 10 as the first rung for everyone — `regular_10` already exists. |
| B4: city boards are "minor-safe by construction" | Conclusion right, reason stale. What makes them safe is **k-anonymity** (`HAVING count(*) >= CITY_BOARD_MIN_MEMBERS`), not an age rule. |
| B1: "show it on the facility page and the map pin" | Facility page yes. **Map pin no, in v1** — it is the 9-touch-point chain deliberately deferred at ROADMAP 8.5, and `facilitiesGeoJSON` returns the whole 12k corpus in one response, so a per-pin rolling aggregate is a materialized-view problem. |
| A1: "into the contribution paths **or** a light post-write job" | Not equivalent. `passportEvents` is deliberately unbounded (`db/src/passport.ts:44-47`) — inlining puts a full-history scan inside the transaction that adds a facility, and inside `checkIn` it could roll back an attendance, breaking *"nothing refuses a check-in."* **Job only.** |
| A5: "the query engine for all of this already exists" | Three of four. **Rank movement has no data source** — `memberStanding` has no upper time bound and no historical rank is stored anywhere. |
| A4: streak freeze is "the cheapest anti-churn mechanic" | Not in this repo. `lib/src/badges/streaks.ts` is deliberately **pure and stateless**; a freeze introduces persistent state into a fold over history. It is the *second-largest* Tier A item. |
| §0: `/sedmitsata` has zero links | It has no nav entry and no index route (correct), but `digest-panel.tsx:37` links every offered city. The genuinely link-less page is `/kampanii`. |
| §0: check-in shows no number | Correct, and **narrower than implied** — verify and condition already interpolate via `Contribute.thanksWithPoints`. A2 is two specific gaps, with a working pattern to copy. |

---

## 2. Blockers the proposal missed

These are the ones that would have been discovered mid-build.

**Sharing / OG**

1. **An OG image is a separate URL carrying no page metadata.** `/pasport/[handle]`
   and `/klasirane` are noindex — but `app/robots.ts:11` disallows only `/admin`
   and `/api/`. Bolting a card onto a noindex page **mints a new indexable URL
   whose pixels contain a member's name.** Fix: `X-Robots-Tag: noindex,
   noimageindex, noarchive` on the image *response*. Never a robots.txt Disallow —
   Facebook's crawler honours robots.txt and the preview would silently die.
2. **Therefore OG images must not live under `/api/`** — already disallowed. Use
   `/og/...`.
3. **`ImageResponse` defaults to `cache-control: public, immutable, max-age=31536000`.**
   A one-year immutable cache of a named card *is* the materialised named artifact
   migration 0012 forbade — an erased member cannot revoke it. Person-scoped cards
   need `private, no-store` **and** `export const dynamic = 'force-dynamic'`, so
   Next's ISR cache never writes the PNG to disk either.
4. **The middleware matcher `/((?!api|_next|_vercel|.*\..*).*)`  locale-rewrites any
   dotless path.** An `/og/` route needs a dotted final segment (a directory
   literally named `card.png`), exactly as `/tiles/*.pmtiles` and
   `sitemap.xml/route.ts` already do. Using Next's `opengraph-image.tsx` file
   convention under `app/[locale]/` instead emits a `/bg`-prefixed URL that 307s
   on every scrape.
5. **No locale channel for `/og` routes.** Dotted paths skip middleware, so
   next-intl never sets a request locale and *every* card renders in Bulgarian —
   including cards referenced from `/en/` pages. Decide: a locale segment
   (`/og/[locale]/...`), or declare cards bg-only and drop `locale` from the
   catalogue signature.
6. **`.woff2` is not supported by satori.** The `.woff` subsets are mandatory;
   `@fontsource` ships both.
7. Font strategy: **copy the woff into `apps/web/public/fonts/manrope/`**, not
   `outputFileTracingIncludes`. The Dockerfile copies `public/` verbatim,
   `public/fonts/` already holds binary assets, and standalone `server.js` calls
   `process.chdir(__dirname)` so `process.cwd()` is `apps/web` in dev *and* in the
   container. nft following pnpm's symlinked store with no `outputFileTracingRoot`
   is the fragile case, and its failure is prod-only and silent.
8. **False alarm, do not chase it:** one agent flagged `NEXT_PUBLIC_SITE_URL` as
   baked to localhost in the prod image. Refuted at the Next source — the
   DefinePlugin substitution only fires for `NEXT_PUBLIC_*` keys actually set at
   build time, and the Dockerfile sets none, so it stays a live runtime read.
   `metadataBase` will be correct. The *real* residue is smaller: `app/robots.ts`
   is a static route with no `dynamic` export, so its `sitemap:` URL does bake the
   localhost fallback at build.

**Design**

9. **`no-hardcoded-design-values.test.ts` scans `components/ui`, `lib/design`,
   `app/[locale]/design-system`** ✔ and fails on any hex or raw px. `ImageResponse`
   resolves **no CSS variables**, so every card is necessarily literal hex and px.
   Put the templates in `lib/design/` — the natural-looking home, next to
   `SPORT_VISUALS` — and every card fails CI. They go in a new `apps/web/lib/og/`.
10. **There is no toast, dialog, portal, sheet or overlay primitive anywhere.**
    16 files in `components/ui`, none of them one. The only live regions are
    inline `role=status` paragraphs in forms. A1's celebration is a new
    server-rendered inline banner, not a wiring job on existing machinery.
11. **Four pre-existing WCAG AA failures sit directly under the new surfaces**:
    Badge `tone=warning` soft 2.62:1 and solid 2.97:1, Button `variant=accent`
    3.25:1, `--text-muted` 4.29:1 at the 13px caption role. Building the
    at-risk-streak and celebration surfaces on top of them ships an accessibility
    regression as a feature.
12. **`/obekt/[slug]` never wraps in `AppShell`** — a bare `<main>`. It is the
    highest-traffic SEO page and the destination of nearly every share in this
    plan, and arrivals get a facility, a footer, and no way onward. This is a bug,
    not a refinement.

**Data / process**

13. **Migration snapshots.** `db/migrations/meta/` holds one `NNNN_snapshot.json`
    per migration. A hand-written `.sql` + journal entry with **no snapshot** means
    the next `pnpm db:generate` re-emits the tables as if they never existed. The
    workflow is: declare in `db/schema/`, run `db:generate` for SQL + snapshot,
    then hand-edit the SQL header and hand-bump `when`.
14. **Journal `when` ✔.** Current max is **1785084000000** (idx 24,
    `0024_harden_sponsorship_windows`). `db/src/journal.test.ts` asserts strictly
    increasing stamps; drizzle-kit's real-time stamp would be *lower* and the
    migration is silently skipped — exit 0, deploy green, table absent.
15. **`account_deletions` counters are a four-place change**, not a list append: a
    `DeletionSummary` field, the INSERT column list, an integer column in
    `db/schema/auth.ts`, **and** the `account_deletions_counts_non_negative` CHECK
    that enumerates every counter by name. The migration must DROP and re-ADD that
    CHECK. `apps/web/tests/account-deletion.test.ts` answers counts *positionally*
    from a fixed array and will break on insertion order.
16. **`lib/package.json` exports is a closed list of 20 subpaths, no wildcard.**
    `@sportkarta/lib/share`, `/legend`, `/divisions` do not resolve until added —
    and a client component reaching for the barrel instead drags nodemailer and
    `node:fs` into the browser bundle.
17. **The mail pipeline has no ICU formatter.** `lib/src/email/weekly-digest.ts:62`
    does a bare `template.replace(/\{(\w+)\}/g, …)`. `{weeks, plural, …}` does not
    match `\w+`, so the raw ICU source string ships in the email body. That is why
    `DigestEmail.introOne`/`introOther` exist. Every email plural must be split
    into one-form/other-form siblings.
18. **`lib/src/badges/rules.test.ts:365` asserts `LAUNCH_BADGES` has length 10.**
    Adding milestone badges fails it — the kind of hardcoded count that reads as a
    broken build.
19. **Adding a `PassportEventKind` is not inert.** `CAMPAIGN_EVENT_KINDS` is
    `PASSPORT_EVENT_KINDS.filter(k => k !== 'session_attended')` — a *subtractive*
    filter. A new kind auto-renders a checkbox on the admin campaign form, passes
    validation, and compiles to SQL matching a `points_event` value that doesn't
    exist: **the campaign scores zero, with no error and no failing test.**
    Converting that filter to an explicit allowlist is a hard prerequisite for B3b.
20. **`GEOFENCE_RADIUS_M` lives in `apps/web/lib/sessions/checkin.ts:87`.**
    `lib/` cannot import from `apps/web`, so any `lib/src/legend.ts` reusing it is
    unbuildable until the constant moves — a change to the most safety-critical
    file in the product.

---

## 3. Phased delivery

Effort: **S** <1d · **M** 1–3d · **L** ~1wk · **XL** more.

### Phase 0 — Truth repairs · S+M · blocking
P0.1 worker mail env (M, unblocks all mail) · P0.2 eligibility copy (S) ·
P0.3 leaderboard comment (S) · P0.4 Cyrillic gate widening (S) ·
P0.5 theme colours + drift test (S).

### Phase 1 — Show the number · S
**A2.** Check-in: `CheckinState.pointsAwarded` **already exists** and is already
returned (`otmetka/[token]/actions.ts:31,80`) — only the render drops it
(`checkin-form.tsx:76-80`). Note the plumbing: `page.tsx:109` pre-resolves all six
outcome strings server-side into a flat map, so an ICU `{points}` placeholder
cannot be filled across that boundary — the form must move to `useTranslations`,
as `verify-form.tsx:35` already does.
Add-facility: carry `result.awarded` into the redirect as a number, and add
`searchParams` to `obekt/[slug]/page.tsx` (which declares none today) — clamp to
0–100, the `points_ledger` CHECK bound, since the value is forgeable.
Do **not** touch verify/condition — they already print the figure
(`verify-form.tsx:141`, `condition-form.tsx:76`); adding a pill there prints it twice.

### Phase 2 — Instrument & frame · S
**C1** Umami `data-umami-event` attributes (v2 autotracks; no new dependency,
no client component). Corrections to the naive list: the public-passport anchor
is in `visibility-panel.tsx:57`, not `pasport/page.tsx`; the directions link is
in `facility-detail-view.tsx:172`; the RSVP form has **one** button whose
join/leave distinction is the form action, so the attribute is a conditional
expression — the allowlist gate must permit that shape.
**Privacy consequence the proposal missed:** this changes analytics from page
views to per-interaction behavioural events, and `Privacy.analyticsBody`
currently promises otherwise. Extend the Privacy namespace in the same commit,
and reconsider `checkin_outcome` — `unscored_out_of_range` / `unscored_daily_cap`
describe the anti-abuse layer's behaviour on an individual. Collapse to
scored/unscored.
**C7** Encode the "showing up, not superiority" rule structurally before any
share copy exists (denylist in a `.json`, not a `.ts` — the gate would flag the
Bulgarian tokens themselves).

### Phase 3 — Notification spine · M+L
**A0** migration `0025` — one shared `member_notifications` ledger carrying badge,
streak, campaign-close, division and legend mail, with the same two-partial-unique-index
shape `play_session_notifications` uses. Three separate ledgers would be three
chances to get idempotency wrong.
**A1** badge evaluation as a pg-boss job (`passport.evaluate`), enqueued after
commit from five server-action call sites; `ownPassport()` keeps calling
`recordEarnedBadges` so a lost job costs nothing. `unseenBadges` already exists as
a standalone export (`db/src/passport.ts:309`) — the nav dot needs no new read.
**The backfill is the single biggest ship risk.** On first run, every member who
has never opened `/pasport` gets their whole retroactive badge set inserted at
once — and a naive notifier mails all of them a list of eight badges the same
night. A one-shot `badges.backfill` queue must run to completion **before**
`badges.sweep` is ever scheduled.

### Phase 4 — Streaks · L
**A3** at-risk sweep. **A4** freeze as a *fold parameter plus consumption ledger*,
not a column — `streakBuckets(events, unit, timeZone)` does not take
`StreakOptions`, so threading `frozen` changes its signature and both other call
sites (`summarizeStreak`, `evaluateStreak` at `rules.ts:235`).
**Unsubscribe is not solved by reuse.** The existing token cancels exactly one
`(member, city)` subscription (`unsubscribeByToken`, `apps/web/lib/digest.ts:87`).
A member subscribed to two cities who unsubscribes from a streak nudge keeps
receiving them via the other row, forever. Either the nudge gets its own
preference + unsubscribe route, or the token's meaning changes. Decide before
building.
**Do not add a naive append-only trigger.** A plain DELETE-refusing trigger fires
during the `ON DELETE CASCADE` from `users` and **aborts account erasure**. The
repo already solved this: `forbid_points_ledger_mutation()` carries an explicit
DELETE escape hatch and a pinned `search_path`. Either copy that verbatim or omit
the trigger — `user_badges`, the closest analogue, has none.

### Phase 5 — Unbury & digest · M+L
**A6** `/kampanii` strip + a `/sedmitsata` index route (which does not exist; the
nav half alone isn't enough). Any new cached locale route needs `setRequestLocale`
*and* `buildAlternates`, per every other public page.
**A7** campaign-close mail. **A5** personal digest blocks — with two hazards:
`digestRecipients` returns one row per (user, municipality), so a member
subscribed to two cities gets the same streak block **twice**; and
`digest-job.ts:163` skips any city with no programming that week, so at launch
most members get no mail at all and the personal block never ships. Both need an
explicit decision.
Rank movement: `memberStanding` joins the **live** consent view, so bounding
points by `asOf` does not bound *membership* — "you dropped 3 places" can be
reported for a member who did nothing, because a rival published their passport.
Either reframe as points-since-Monday, or store a weekly rank snapshot.

### Phase 6 — OG foundation · L+M
**C2a** `metadataBase`, checked-in woff subsets, shared renderer, first public
card. **C2b** session / campaign / results / weekly. Public cards only — nothing
person-scoped yet.

### Phase 7 — Place identity · M+S
**B1** Local Legend, `method='qr'` only, distinct-Sofia-day counted.
**Unresolved and escalated:** the facility page is in the sitemap (~6.6k rows,
`sitemaps/[name]/route.ts:10`) and sets no `robots`. Naming the holder there
publishes a named person tied to one place with a 90-day frequency count — on the
one page where noindex is not an option because it *is* the SEO product. That is
both the indexing rule and the pattern-of-life rule at once. Three buildable
options in §8.
**B3a** milestones — pure catalogue config, but see blocker 18.

### Phase 8 — Person-scoped sharing · M+L
**C2c** no-store / force-dynamic / `X-Robots-Tag` card route · **C4** passport
payload + exact-key test · **C3** the Viber plain-text week · **C6** session
invite.
The `/klasirane` card must load through `leaderboard()` from `@sportkarta/db`
(which joins the view at `:127,:181,:209`) — an implementer writing a bespoke
SELECT to fit the card shape mints a public named ranking that bypasses consent,
and no proposed test would catch it. Pin the loader in the catalogue entry and
assert no file under `lib/og/` contains a raw ``sql` `` template.

### Phase 9 — Divisions · L/XL
**B2.** Needs the consent decision in §8 first, plus a first-week bootstrap path
(the rollover job closes "last week" and assigns "next" — nothing creates week
one, so it is a no-op forever without it).

### Phase 10 — Later
**B4** evergreen per-capita city board (needs the `ekatte_code` hop through
`municipalities` — `municipality_population` is not keyed by `municipality_id`) ·
**C5** recap (needs a real page at `pasport/[handle]/godina/`, which does not
exist — an `opengraph-image` there today would be an orphan) · **B5** clubs ·
**B3b** volunteering count (blocked on blocker 19).

---

## 4. Design specification

The good news: **Trail & Summit already reserves the vocabulary.** `DESIGN_SYSTEM.md`
§3.1 assigns clay/amber to "the earned-badge moment" and §3.7 sanctions
`--ease-trail` for "a badge unlocking" — `globals.css:241-250` already ships one
of the two blessed overshoot animations and names the other.

### D0 — Tokens · S
**Exactly one new hex in the entire design workstream:**

```
--warning-ink: #7E5310;   /* hsl(37,77%,28%) — same hue as --warning, darkened until AA */
```
Measured: 6.37:1 on `--paper`, 5.91:1 on `--warning-bg`, 6.65:1 on `--surface`,
white-on-it 6.71:1. It exists because an at-risk streak must read amber-caution,
and `--warning #C9891F` cannot carry text (2.82:1).

Everything else is **aliases, no new hex**: `--streak-1..5` → `--clay-100..500`
(all carry `--ink` at 4.87:1+); `--frozen-bg/-ink` → `--sky-100/-700`;
`--rung-1..4` → clay-500/600/700 + pine-700 (3.23 / 4.28 / 5.97 / 9.36 as ring
colours, all clearing the 3:1 non-text floor); `--zone-promote-*` → success,
`--zone-relegate-*` → `--paper-sunk` + `--text-muted`.

**Relegation is deliberately not `--danger`.** ENGAGEMENT §1.3 exists *because*
absolute boards demoralise the bottom; painting the bottom five rows red is that
failure rendered in CSS.

Deliberate non-additions, each with a reason: no separate celebration accent
(`--accent` *is* the celebration token; a second festive hue puts two accents on
the passport at once); no streak-fire ramp (clay 100–500 already is one); no
bronze/silver/gold (cannot be expressed in a warm-paper pine/clay palette without
importing a foreign grey — rungs use four depths and encode the fifth step with a
**doubled ring**, and the rung number is always printed inside the disc so the
ladder is legible with no colour perception at all); no dark mode.

### D1 — Achievement celebration: inline banner, not toast · M
Decided by three architectural facts, not taste. (1) The award is written
server-side and observed on the *next* render — there is no client event to fire
a toast from, and no portal/store/timer exists to build one. (2) A toast
auto-dismisses, but this is the primary share desire path — the share trigger
must persist. (3) A modal interrupts a member who just tapped check-in, which
ENGAGEMENT §3 rejects for this audience.

Server component, first child of `<main>`, never fixed-position. Motion is the
entire celebration budget: an 8px rise with 0.96 scale on `--ease-trail` at
`--dur-slow`, plus one non-looping ring bloom. Both one-shot. No
`prefers-reduced-motion` block needed — `motion.css:21-27` clamps every animation
globally with `!important`; the requirement is instead that **no component
encodes information in motion**, which is why the crest carries a static ring at
rest and the count is a printed number.

States: none (renders nothing, the `AdSlot` discipline) · one · several (one
banner, counted crest, comma list — never a stack) · compact (embedded in an
existing status region) · dismissed (server-side, honest across reload).
`role=status` / `aria-live=polite`, never assertive — earning a badge is not an
error.

### D2 — Nav dot · S
Arrives as a **prop**, not a hook — `app-nav.tsx` is pure and props-driven by
design so the client map explorer and the server shell share one source of truth.
Copies `avatar.tsx:59-67`'s presence dot (`border-2 border-surface`) so the two
dots are one language. 10px on the 76px rail, 8px on the 56px tab bar. Clay, not
danger-red: an unseen achievement is an invitation. A visually-hidden count makes
the accessible name *"Профил, 2 нови отличия"* — the dot is never the only signal.

### D3 — StreakPanel: at-risk / frozen / broken · M
One file, one added prop, no new component. Today it is four visually identical
tiles — right for "here are four numbers", wrong for "your streak is about to
break". Promote **weeks** to a hero spanning two columns (ENGAGEMENT A3: the week
is the natural unit for sport), fill from the streak ramp bucketed by value.

Every state carries **two** carriers so colour is never alone: safe = fill +
numeral · at-risk = amber pill + Clock + deadline words (no red anywhere —
`--danger` means *broken*, and the point of at-risk is that it isn't yet) ·
frozen = sky fill + Snowflake + count · broken = flat fill, and the *longest* run
promoted into the hero, finally realising the argument the component's own header
comment has been making in prose since it was written · none = em dashes, not
zeros.
Freeze copy must describe the freeze as **applied**, never as a thing to spend —
CLAUDE.md: earning only, no spending mechanics.
Motion: none. A panel that animates on every passport visit is decoration.

### D4 — ProgressRung · S
`components/ui/progress-rung.tsx`. 44px disc (= `--control-md`, the touch floor,
sized so it can later become a Link without relayout), ring in the rung colour,
target count printed inside in mono. Track fill width is set inline as a
**percentage** and its colour as a `var()` — a percentage contains no px and a
`var()` contains no hex, so both design-token gate regexes are satisfied and the
file can legally live in `components/ui`.
`role=progressbar` with `aria-valuetext` set to the sentence, so a screen reader
hears *"2 more check-ins"*, not *"80 percent"*.

### D5 — Local Legend crest · M
`legend-crest.tsx` (the mark alone, reusable by the OG card) +
`facility-legend.tsx` (the page block). Renders **nothing** when vacant — never a
"be the first" placeholder, which would make all ~6,600 facilities look like a
failed feature. A failed query also renders nothing: a broken decoration must
never break a facility page.
**Not on the map pin**, for three independent reasons: `markers.ts` draws a 36px
teardrop whose single centred glyph already spends its whole budget carrying the
sport; `RECONCILIATION` C9 forbids clay chrome on the map screen where amber
category markers live; and a crest on a pin advertises where a named person
reliably plays.
A challenger within one visit shows a caption in `--warning-ink` with a Clock —
never red, because losing a legend is not a failure.

### D6 — Division ladder · L
An `<ol>` with three regions and one pinned self-reference — **not** a fifth
column on `leaderboard-table.tsx`, which is a four-column ranked index of public
passports with a contributions column a division doesn't have and no zone
semantics at all.
390px degradation, spelled out because this is where it breaks: 358px content;
rank 36px / name flex / points ~45px leaves ~250px for the name, truncated. The
zone chevron sits *inside* the rank cell, not as a fourth column. Avatars omitted
below `sm` — 30 avatars is 30 requests for decoration. 30 rows ≈ 1560px ≈ 2.5
screens, which is why the docked own-row island exists. At `lg` the ladder
becomes two columns of 15, which is the second reason zone headers are `<li>`
elements rather than table sections: they can repeat per column.
Zones are stated in **words** in group headers, never carried by tint alone.

> ⚠️ **The anonymous-row design is contradicted by the repo and must not ship as
> drafted.** `db/src/campaigns.ts:317-320` on `publicStandings`: ranks are computed
> *after* the eligibility join specifically so the board reads 1,2,3 "without gaps
> that would otherwise advertise the existence of hidden competitors." The one
> place a withheld row does render (`frozenResults`) is justified for a member who
> has *since* gone private keeping an already-frozen placing — not a
> never-consented member inserted into a live ladder. And mechanically, a query
> that joins the view yields **no row at all** for a non-consenting member, so
> rendering one means reading `users` directly and having JSX decide not to print
> the name — relocating the consent guarantee from SQL to JSX, which is exactly
> what the rule forbids. Default to: join the view, rank after the join, contiguous
> 1..N. If the true field size matters, express it as one aggregate line ("N members
> in this division"), never as per-member rows.

### D7 — Share affordance · M
The trigger must be **labelled** — the UX audit's cross-cutting P1 is
discoverability and an unlabelled icon is the least discoverable control there
is. `Button size=md` (h-11, the touch floor) with a visible label, never a bare
`IconButton`.
Three tiers at click time: `navigator.share` → `clipboard.writeText` → open the
panel. The fallback is a **disclosure, not a modal** — this app has no dialog
primitive and does not need one for a URL. Never `disabled`: a disabled share
button is a dead control, and `DEAD-CONTROLS.md` has a standing rule against
orphan-disabled buttons.
Panel contents: the URL in a copy well; the C3 plain-text block in a readOnly
textarea with its own copy control; and two plain anchors — **Viber first, then
Facebook**, per ENGAGEMENT §1.1. No SDK, no iframe, no pixel.
Copied state: label swaps for 2400ms **and** a visually-hidden `role=status`
announces it — a label swap alone is not announced by every screen reader.

### D8 — PointsAward · S
Returns **null** at zero. This is the design contract, not an optimisation: an
unscored check-in must never render "+0", because a zero reads as a punishment
for a fact the system has already promised always to record. The caller owns the
live region (matching `condition-form.tsx:75`), so a check-in that both scores
and earns a badge announces **once**.

### D9 — OG cards · L
Everything under `apps/web/lib/og/` — **never** `lib/design/` (blocker 9).
`palette.ts` transcribes each hex with its `colors.css` source line and ships a
test parsing that file, so the duplication cannot drift. `fonts.ts` reads the
four woff buffers at **module scope**, not per request.
Shared grammar across all six: 1200×630 on `--paper`; a **64px safe area** on
every edge (Facebook crops ~5% on some surfaces, Viber renders a 1.91:1 crop —
64px absorbs both); a 12px full-bleed left rule in the card's own accent, the one
graphic constant that makes the six read as a set; wordmark footer. Explicit type
scale, since no token resolves here: eyebrow 24 mono / title 68 Manrope 800 at
1.05 clamped to two lines / subtitle 30 / stat 56 mono / label 22.
Satori constraints: `display:flex` on every multi-child element, no CSS variables,
no external stylesheet, no `url()` beyond a data URI, **no emoji** (DESIGN_SYSTEM
§2 forbids emoji in product UI — the emoji grid belongs to the C3 *text* share).
Uniform fallback policy: a missing field removes its **row**; a missing stat
prints an em dash — never "null", never 0.
Attribution: OSM + Protomaps on any card naming a mapped place (facility,
session, weekly). Not on passport, campaign, recap.
**Caching splits by card, not globally** (blocker 3): facility / session / weekly
/ campaign may set `revalidate`; passport and recap must be `force-dynamic`.
The recap card renders the **non-personal invitation variant** below three
events — Wrapped 2024 failed by printing things that weren't true, and a card of
zeroes is the same failure in the other direction.

### D10 — Accessibility contract · M
Passing on the real backgrounds: `--ink` 15.05 · `--ink-soft` 10.03 · `--brand`
6.63 · `--accent-active` 5.67 · `--success` 4.77 · `--warning-ink` 6.37 ·
`--sky-700` 5.78.
**Never for meaningful text on the new surfaces**: `--text-faint` 2.50 ·
`--warning` 2.82 · `--info` 3.34 · `--accent` 3.09 · `--text-muted` 4.29.
Two-line repair that fixes every existing warning Badge in the app: `warning`
soft → `text-warning-ink` (5.91), solid → `bg-warning-ink` (6.71).
`Button variant=accent` at 3.25:1 is an operator-visible brand change — see §8 —
but **no new accent CTA should ship before it is resolved**.

### D11 — Screen tweaks
**T1 (highest priority, a bug):** wrap `/obekt/[slug]` in `AppShell`.
**T2:** `/pasport` is five sections of identical weight — promote points to a
single hero stat, drop the other four to a 2×2, banner first, share moved up out
of the visibility panel's footer.
**T4/T6:** division becomes the default `/klasirane` view; the your-standing card
becomes the ladder's docked row so there is one self-reference, not two.
**T5:** the filter nav renders 29 sport pills + every ranked city + two periods as
three undifferentiated wrapped rows — a wall at 390px. Collapse sports behind a
disclosure and reuse the map's FilterSheet rather than inventing a second one.
**T7:** the live-campaign strip goes *inside* the list panel header, never floating
over the canvas (UX-AUDIT P1 was an occluded floating control), and is
brand-toned rather than clay (RECONCILIATION C9).
**T9/T10:** the session header goes two-column at `sm` with the accent share on
the right, and the cancelled/started notices cool to neutral so the page keeps
exactly one accent moment.
**T11:** the campaigns card goes on `/sesii` where `COVERAGE-MATRIX.md` already
decided it goes. Don't invent a different placement.

### D12 — Register on `/design-system` · S
In the **same commit** as each primitive — the catalogue's value is that it is
never behind. Note `design-system/page.tsx` is `'use client'`, so
`AchievementBanner` and `DivisionLadder` (async server components reading
`next-intl/server`) **cannot be registered as-is**; either split off a pure
presentational core or leave them out. `PointsAward`, `ProgressRung`,
`LegendCrest` and `ShareButton` register normally.

---

## 5. Data layer

**Four migrations**, `0025`–`0028`, each hand-stamped above 1785084000000 ✔ and
each with its generated snapshot (blocker 13).

| # | Contents | Notes |
|---|---|---|
| ~~0025~~ **0026** | `member_notifications` (shared ledger, two partial unique indexes) + notification prefs | Deferred until mail actually ships — it is only needed by the notifier |
| **0025** ✅ | `streak_freezes` | **Landed 2026-07-26.** Trigger decision stated in the header (there is none, and why) |
| 0027 | `facility_legends` (announcement ledger; the title itself stays a live query) | |
| 0028 | `division_groups` + `division_members` | "One group per member per week" is a composite FK + unique index, not app code |

> Numbering changed from the original plan: `streak_freezes` took **0025** because
> the notification ledger it was queued behind is blocked on the mail decisions
> and had nothing to write to it. The next migration is **0026** and will need its
> journal `when` hand-bumped above **1785087600000**.

**Tier A needs no new badge state** — `user_badges` already has `first_seen_at`/
`seen_at`, and B3's milestones are pure catalogue entries.

**Index correctness (a spec error worth repeating):** `points_ledger_user_created_idx`
is `(user_id, created_at)` — leading column `user_id`, so a bare
`created_at > now() - 48h` across all users **cannot use it**.
`play_session_checkins_user_idx` is `(user_id)` only and there is **no index on
`checked_in_at` anywhere**. Any nightly candidate sweep needs a purpose-built
index, or it is two sequential scans.

**A daily frequency cap cannot be a computed-expression index.**
`timezone('Europe/Sofia', sent_at)` is STABLE, not IMMUTABLE, and Postgres
rejects it — the same reason every other civil-Sofia boundary in this repo is
computed in TypeScript and stored. The cap needs a stored `sofia_day date`
written by the caller.

**Jobs**: payloads carry **account ids, never addresses** (a job row outlives the
account it names); Sofia-timezone schedules copied from the digest's, or the
nudge drifts an hour twice a year; no PII in logs, counts and error *categories*
only.

---

## 6. i18n

~120 new keys across new nested namespaces: `Achievement`, `Legend`, `Division`,
`Share` (including every share-text template), `Og`, plus `Passport.streak`,
`Badge.rung`, `Points.award`, `Nav.unseen`, `DesignSystem.groups.engagement`.
All **nested**, never dotted.

- Every Cyrillic character in a share payload or a card lives in `messages/*.json`.
- Email strings **cannot use ICU plurals** (blocker 17) — split into
  one-form/other-form siblings, and extend both `digestStrings()`'s explicit
  `pick()` whitelist in `digest-job.ts:60-91` **and** the `DigestStrings` interface,
  or the key is invisible to the mail.
- Badge names/descriptions already exist under `Badge.<slug>.*` — reuse, don't
  duplicate. But note the worker types the catalogue as
  `Record<string, Record<string,string>>` and `Badge.<slug>.name` is three levels
  deep, so a badge mail needs either a flat mirrored namespace or a typed nested
  reader.
- New badge names need the same operator approval the existing ten got — raising
  or renaming a badge later **takes it away from people who hold it**.

---

## 7. Tests & Definition of Done

New gates:
- **Cyrillic gate #2** over `lib/src` + `apps/worker/src` (P0.4).
- **Catalogue↔i18n parity** — nothing today ties `LAUNCH_BADGES` to its two
  required message keys, so a milestone badge can ship with no name.
  `badge-grid.tsx:8-11` claims the parity test catches this; it does not.
- **Consent registry** for public rankings. Per-file scanning is already defeated:
  `db/src/campaigns.ts` contains `leaderboard_eligible_members` five times *and*
  `adminStandings` joining `users` directly. The assertion must be
  per-`sql` template or per-exported-function.
- **OG**: Chromium-free render test asserting non-empty PNG bytes **from a
  Cyrillic string** (a Latin-only render passes with the wrong subset traced);
  font resolution via `require.resolve('@fontsource/manrope/package.json')`, never
  a hardcoded `.pnpm` path; a no-storage-write assertion on person-scoped routes.
- **Exact-key test** for every new share payload, modelled on
  `passport-privacy.test.ts` — "does not contain" only catches leaks somebody
  already thought of.
- **Render tests pinning the "renders nothing" contracts** — `PointsAward` at
  zero, `AchievementBanner` empty, `FacilityLegend` vacant or errored. Nothing in
  `apps/web/tests` would currently catch a regression that starts printing "+0".
- **A test that a throwing enqueue still records the attendance** — the invariant
  at `checkin.ts:55-59` deserves a named deliverable, not a risk bullet.

**DoD per item:** typecheck + lint + test green · bg/en parity · both Cyrillic
gates · design-token gate · client-imports gate · migration reviewed by
`db-migration-reviewer` (mandated by CLAUDE.md and easy to skip on a hand-written
migration) · snapshot generated · journal `when` bumped · `.env.example` updated
for any new flag · `deploy/compose.prod.yml` updated for any worker-read variable
· erasure path checked · `/design-system` registration in the same commit.

---

## 8. Operator decisions

**Blocking — work cannot start without these:**

1. **Local Legend naming on an indexed page.** Options: (a) crest + count + window,
   **no name**, on `/obekt/[slug]`, naming the holder only on noindex surfaces;
   (b) named block only for signed-in viewers, unnamed for the crawler (the page
   is already dynamic and already calls `getCurrentUser()`); (c) a third explicit
   opt-in — which would be a *new consent column*, not a widening of the view.
   Recommendation: (a) for v1.
2. **Division consent.** Recommendation: reuse the campaigns pattern — score
   everyone, join the view for display, contiguous ranks. The anonymous-row
   variant is a reversal of a documented decision and should be recorded as one if
   wanted.
3. **Streak-nudge unsubscribe** — own preference + route, or redefine the existing
   token? Affects migration 0026.
4. **Mail frequency cap.** Badge + streak-at-risk + streak-broken + division +
   legend + campaign-close + weekly digest could put four mails in one weekend.
   Recommendation: one optional engagement mail per member per civil Sofia day —
   and decide which kind **wins** on a collision, or a dropped mail looks like a
   bug.
5. **Badge backfill visibility** — write `seen_at = now()` (silent, nothing lights
   up) or leave NULL (a member who never opened `/pasport` sees "8 new" on their
   first visit)? Recommendation: silent.
6. **`Button variant=accent` at 3.25:1.** Moving the resting fill to clay-700
   (5.97:1) passes but is a visible brand change on every accent CTA. No new
   accent CTA should ship before this is answered.

**Non-blocking but needed soon:** B1 tie rule and minimum qualifying visits · B2
constants (30/7/5, and the launch roster floor) · milestone thresholds and
whether organising counts on the same ladder · division names (numbered, or
Bulgarian place/nature names — this decides whether a fifth colour is ever
needed) · recap period (calendar year vs first-anniversary; it determines the URL
shape, so decide before C5 starts) · per-capita city board population floor ·
`themeColor` pine vs paper · who writes idiomatic English for ~120 keys · club
creation/joining policy.

---

## 9. Sequencing

```
Phase 0  Truth repairs ..................... blocking, ~1 week
Phase 1  Show the number ................... S      ← smallest felt win
Phase 2  Instrument + framing rule ......... S      ← runs 2–3 wks before cards
Phase 3  Notification spine + badges ....... M+L
Phase 4  Streaks (at-risk, freeze) ......... L
Phase 5  Unbury + campaign close + digest .. M+L
Phase 6  OG foundation + public cards ...... L+M
Phase 7  Local Legend + milestones ......... M+S
Phase 8  Person-scoped sharing + text week . M+L
Phase 9  Divisions ......................... L/XL
Phase 10 City-vs-city, recap, clubs ........ later
```

Two dependencies the proposal's own §5 sequencing does not name:

- **B1 and B2 are data-gated, not effort-gated.** `play_session_checkins` held
  **0 rows** as of 2026-07-23. Local Legend returns null everywhere until session
  volume exists; divisions need ~60 weekly-active members to be meaningful. Ship
  them early because they are cheap and correct — **not** because they will be
  felt early.
- **Phase 2 before Phase 6.** ENGAGEMENT C1 exists so the Umami data picks which
  cards to build. Shipping the facility and session cards immediately is
  defensible (they name nobody, pure upside); holding the person-scoped ones for
  real data is the point of instrumenting at all.

And the expectation-setter from the proposal that survives contact with the code:
the JMIR 2025 meta-analysis found gamification worked only **beyond 12 weeks**.
This is a multi-season programme, not a launch stunt.
