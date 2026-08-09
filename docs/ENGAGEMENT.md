# SportKarta — Engagement & Social Sharing Plan (v1, 2026-07-25)

Status: PROPOSAL. Grounded in a four-lane research pass (2026-07-25): an audit of
the engagement machinery already in the repo, an audit of every sharing/OG/image
surface, an external evidence review (Strava, Duolingo, parkrun, Wrapped, Wordle,
peer-reviewed RCTs), and a guardrails audit. Sources cited inline where a number
is load-bearing.

---

## 0. The finding that reframes everything

**You do not have an engagement problem. You have a surfacing problem.**

The engine is built, correct, and anti-abuse-hardened — and almost none of it
ever reaches a member:

| Built                                            | What the member experiences today                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10 badges, derived + retroactive                 | **Nothing.** `recordEarnedBadges()` is called from exactly one place — `ownPassport()` — so a badge row does not exist until the member personally opens `/pasport`. No email, no toast, no nav dot. |
| DST-correct day + week streaks                   | **Nothing.** `summarizeStreak` runs only during a passport page render. No job, no email, no banner. The member is never told a streak is at risk, or that it broke.                                 |
| National / city / sport leaderboards             | Visible, but only if you find `/klasirane` — the one engagement surface with real nav placement.                                                                                                     |
| Campaigns with scoring, prizes, frozen standings | `/kampanii` has **zero inbound links** from the public site. Already logged as buried in `docs/audit/BROKEN-CHAINS.md:145`. Closing a campaign notifies nobody.                                      |
| Adding a facility = 10 points, the largest award | **No acknowledgement at all.** `dobavi/actions.ts` redirects with `?added=1`, which nothing reads. (Verify and condition flows _do_ thank you.)                                                      |
| QR check-in scoring                              | "Получихте точки." — **with no number**, though the action returns `pointsAwarded`.                                                                                                                  |
| Weekly digest email                              | City programming only. No points, no badge, no streak, no standing.                                                                                                                                  |
| `/sedmitsata/[city]` weekly page                 | Buried — no nav entry, no index route.                                                                                                                                                               |
| Sharing                                          | **Zero affordances repo-wide.** No `navigator.share`, no clipboard, no OG image anywhere, no "сподели" string.                                                                                       |

Duolingo's own conclusion after instrumenting where users screenshot: _"Stop
building share buttons. Start paving desire paths."_ Their investment in three
already-screenshotted moments produced a **5–10× increase in organic sharing**
([startupspells.com](https://startupspells.com/p/duolingo-screenshot-tracking-viral-strategy)).
SportKarta's desire paths are currently unpaved _and_ unlit.

---

## 1. Three findings that should change the design

### 1.1 Bulgaria shares on Viber and Facebook — not Instagram

DataReportal Digital 2026: Facebook **3.60M** (53.7%), TikTok **2.63M** adults,
Instagram only **1.95M** (29.1%). Facebook has ~1.85× Instagram's reach, and
TikTok outranks Instagram. **Viber is the #1 messaging app nationally** (~2.5M
users, one of very few countries where this is true).

**Design consequence:** an Instagram-Stories-first 1080×1920 image card would
miss the country's main sharing surface. What travels on Viber and Facebook is
**a pasteable link with a good preview** and **plain text**. Wordle went viral
because of its _format_ — a spoiler-free emoji grid that was plain text and
therefore crossed every messenger simultaneously with no app, link or account.

→ Priority order for SportKarta: **(1) OG link previews, (2) a Wordle-style
plain-text result, (3) image cards.** That is the inverse of the usual advice.

### 1.2 61% of Bulgarians never exercise — so reward showing up, not performance

Special Eurobarometer 525 (2022): 61% of Bulgarians never exercise or play sport
(improving steeply from 78% in 2017). Mechanics tuned for people already
training daily — Strava KOM, Peloton live output — exclude exactly the people
the NGO exists to reach.

The two mechanics that fit are both attendance-based:

- **Strava Local Legend** (2020): awarded to whoever completes a segment the
  **most times in a rolling 90 days**. Rewards consistency, not speed; winnable
  by anyone; and it **decays** — you must keep showing up or lose it.
- **parkrun milestones**: counted by attendance, where **walking and volunteering
  both count**, with a separate lower first rung (10) for under-18s.

### 1.3 Relative competition beats absolute — and social comparison is the active ingredient

- **Zhang et al. 2016** (Preventive Medicine Reports, 4-arm RCT, n=790, 13 weeks):
  weekly exercise-class attendance was **35.7 and 38.5** in the arms containing
  social comparison vs **20.3** control — ~90% higher (p=0.003). **Social support
  alone was ineffective** — numerically _worse_ than control (16.8).
  ([PMC5008041](https://pmc.ncbi.nlm.nih.gov/articles/PMC5008041/))
- **Absolute leaderboards demoralise the bottom** — the gap reads as
  insurmountable; top-third motivation did not translate into engagement.
  **Relative leaderboards** (you see only near neighbours) produced higher
  engagement, better performance and "constructive competitiveness".
- Duolingo's league is exactly that: **30 players, top 7 promote, bottom 5
  relegate, middle 18 stay** — promotion deliberately _more likely_ than
  relegation, with automatic "league pause" protecting inactive users.

→ SportKarta's current national leaderboard is **absolute** — the strongest
single upgrade available is to make competition _local and relative_.

---

## 2. Proposals

Ordered by (impact ÷ effort). Everything in Tier A is surfacing work on machinery
that already exists and is already tested.

### TIER A — Light up what you already built (weeks, not months)

- **A1. Tell people when they earn a badge.** Today `recordEarnedBadges()` runs
  only on a passport visit. Move badge evaluation into the contribution and
  check-in paths (or a light post-write job), and surface it three ways: an
  in-app celebration on the next page load, a nav dot on the passport tab, and a
  line in the weekly digest. Duolingo's milestone animations alone raised day-7
  retention **+1.7%**.
- **A2. Show the number.** `Checkin.outcome.scored` says "Получихте точки." while
  the action already returns `pointsAwarded`. Render it. Same for the
  add-facility flow, which today gives **zero** feedback for the platform's
  largest award (10 points).
- **A3. Warn before a streak breaks.** A streak nobody is told about cannot
  motivate. Duolingo's model: a reminder derived from the member's _own_
  behaviour (they use 23.5h after last activity), plus an at-risk nudge — never
  a fixed marketing clock. For a sport platform the natural unit is the **week**
  streak, not the day.
- **A4. Give the streak slack — "замразяване" (streak freeze).** Duolingo tested
  1/2/3 freezes: two beat one, three added nothing; two simultaneous freezes
  raised DAU **+0.38%**, and freezes apply _silently_. Slack during goal pursuit
  beats rigid rules. This is the single cheapest anti-churn mechanic available.
- **A5. Make the weekly digest personal.** It currently contains city programming
  only. Add: your streak, your rank movement, your nearest badge ("2 more
  check-ins"), and the one campaign closing soonest. The query engine for all of
  this already exists.
- **A6. Unbury campaigns and the weekly page.** `/kampanii` has zero inbound
  links; `/sedmitsata` has no index and no nav entry. Add a live-campaign strip
  to the map screen and the leaderboards page, and link the weekly page from the
  city pages. (Both already logged in `docs/audit/BROKEN-CHAINS.md`.)
- **A7. Notify on campaign close.** Standings freeze and nobody is told. The
  moment a campaign closes is the single highest-emotion moment the product
  produces — and it currently produces silence.

### TIER B — Make the competition winnable and local

- **B1. «Господар на игрището» — Local Legend per facility.** Most check-ins at a
  given facility over a rolling 90 days. This is _the_ mechanic for a facilities
  platform: it is winnable by a beginner, it decays so it must be defended, and
  it attaches identity to a **place** — which is the product's entire subject.
  Show it on the facility page and the map pin.
- **B2. Weekly divisions instead of one national ladder.** Groups of ~30 members
  of similar activity, Monday→Sunday Sofia weeks, top promote / bottom relegate,
  with inactivity protection. Turns "I am #4,318 nationally, forever" into "I am
  6th and 4th promotes."
- **B3. parkrun-style attendance milestones.** 10 / 25 / 50 / 100 / 250 sessions,
  each visually distinct, with **10 as the first rung for under-18s**. Counts
  attendance, not ability. Add a volunteering/organising count so the person who
  runs the session is also rewarded — parkrun's evidence is that continued
  participation is driven by achievement, community _and volunteering_.
- **B4. City vs city.** Campaign city boards already exist (`CITY_BOARD_MIN_MEMBERS
= 5`, nobody named) — they are **minor-safe by construction** and therefore the
  one competitive surface that can include everyone. Chipotle × Strava's 2025
  City Challenge ran exactly this: collective city mileage _and_ individual Local
  Legend over the same activity — two nested competitions, one action.
- **B5. Clubs / teams.** Strava's 2025 Year in Sport: **1M clubs, nearly
  quadrupled YoY**, running clubs +3.5×, club-organised events +1.5×. Gen Z is
  39% more likely than Gen X to use fitness to meet people. A club is also the
  natural unit for a school, a neighbourhood, or a company sponsor (ties directly
  to `docs/MONETISATION.md` S1/S2).

### TIER C — Pave the sharing desire paths

- **C1. Instrument before you build (Duolingo's method).** Umami currently has
  **zero custom events**. Add `data-umami-event` attributes to find where people
  already linger, copy, and screenshot. Build cards for _those_ moments only.
  This costs almost nothing and prevents building three cards nobody posts.
- **C2. OG images everywhere — the highest-leverage sharing work.** Only two
  files in the entire app set `openGraph`, none set `images`, and `metadataBase`
  is unset. **This is verified feasible**: `next/og` is present and a live probe
  rendered a 1200×630 PNG with perfect Cyrillic using the bundled Manrope
  `.woff` subsets. Cover facility pages, session pages, campaigns, leaderboards,
  the weekly page.
- **C3. The Viber-native plain-text result.** A short, pasteable, emoji-marked
  block — the Wordle format, which is _why_ Wordle spread. Something like a
  week's activity as a compact grid plus a link. No image, no app, no account;
  it crosses Viber, Messenger, Facebook and SMS simultaneously.
- **C4. Passport share card.** Constrained to exactly the `PublicPassport`
  whitelist (`displayName`, `homeCity`, `memberSince`, totals, badges dated to a
  **month**, streaks) — the privacy ceiling is already defined and pinned by an
  exact-key test. Never a facility, a day or a time.
- **C5. «Моята година» / season recap.** Spotify Wrapped works because it is
  **true and specific** about the poster; its 2024 collapse came from replacing
  real stats with AI-invented labels. SportKarta has real, defensible stats.
  A season recap (or a first-anniversary recap per member) is the highest-value
  single share artifact — and it is annual, so it costs one build for years of
  use.
- **C6. Session invite cards.** "Играем в четвъртък 18:00 — ела." The session
  page already has a good Bulgarian description and no OG image. This is the
  share with the clearest _action_ attached, and the only one that recruits
  rather than brags.
- **C7. Make sharing identity-expressing, not bragging.** Sezer/Gino/Norton (JPSP)
  found humblebragging makes people **less liked and less trusted** than plain
  bragging; self-promoters systematically overestimate how positively their
  sharing lands. Frame cards around _showing up_ and _belonging to a place_
  ("50 тренировки", "Господар на Южен парк"), not superiority.

### TIER D — Recruitment loops

- **D1. Invite-a-friend, attributed.** The session invite and the campaign are
  the two natural invite carriers. Attribute a joined friend to the inviter — a
  badge for bringing three people is more ethical and more effective than any
  points bribe.
- **D2. Organiser tooling as growth.** ROADMAP 4.7 (member session creation
  behind an achievement gate) is exactly the right shape: the reward for
  competing is **the ability to convene others**, which then recruits. Unlocking
  capability beats unlocking cosmetics.
- **D3. Partner with 5kmRun.bg rather than against it.** 39,746 participants,
  3,280 runs, 1.9M km — the parkrun playbook already runs in Sofia, Plovdiv,
  Varna and Burgas. That is an existing free-weekly-sport culture with a
  ready-made audience.

---

## 3. What we will NOT do, and why

| Rejected                                            | Reason                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily-streak loss pressure aimed at minors          | Streaks are Octalysis Core Drive 8 — pure Black Hat (loss aversion). The EU **Digital Fairness Act** (proposal expected Q4 2026) explicitly targets addictive design with **minors named** as a protected group. Week-streaks with freezes, yes; daily guilt loops on children, no. |
| Absolute national ranking as the primary board      | Demoralises the bottom, which here is most of the addressable population. Keep it, but make divisions the default view.                                                                                                                                                             |
| Third-party share SDKs / Facebook pixel             | Would require a consent banner, breaking a published privacy promise and the cookieless architecture. All sharing must be plain links, `navigator.share`, and self-hosted images.                                                                                                   |
| Indexing person-naming pages                        | `/pasport/[handle]` and `/klasirane` are noindex _deliberately_: "Public means anyone I send the link to, not indexed against your name forever." Shareable ≠ indexable.                                                                                                            |
| Storing a rendered share image containing a name    | Migration 0012's lesson: a frozen name is "retaining personal data in a table erasure cannot reach." Generate share images **on demand** from live data; never materialise a named artifact.                                                                                        |
| Cheapening the streak to boost DAU                  | Duolingo tried letting a single exercise extend the streak: DAU did not rise, it captured only the least-engaged, and their PM calls cheapening the streak "an extinction-level event" for long-term retention.                                                                     |
| Fabricated or embellished stats in recaps           | The Wrapped 2024 failure. A recap is only shareable if it is true.                                                                                                                                                                                                                  |
| Rewarding late-night or remote check-ins for minors | The Strava/Kim Flint precedent: a "most visits" leaderboard creates incentives to travel at times and in ways the operator would not endorse. Needs hazard awareness built in from day one.                                                                                         |

---

## 4. Constraints any of this must respect (from the guardrails audit)

- **Minors are locked out of every named public surface by SQL, not code** —
  `users_minor_profile_not_public` CHECK (written as an allowlist, so future
  visibility values stay forbidden until deliberately permitted) and the
  `leaderboard_eligible_members` view whose comment reads **"MUST NEVER BE
  WIDENED."** Minors _are_ counted in campaign scoring and aggregate city boards.
  Every new competitive surface must join that view, not `users`.
- **The passport payload is a whitelist with an exact-key test**
  (`apps/web/tests/passport-privacy.test.ts`). Any share payload should be a
  declared type with the same treatment — "does not contain" only catches leaks
  somebody already thought of.
- **No coordinates exist.** `play_session_checkins` stores `distance_m` only, and
  a test asserts against `information_schema` that no lat/lon column exists. A
  "places I've played" map card **has no data source, by construction**.
- **Anti-farming already holds**: `points_ledger` unique idempotency keys,
  `points BETWEEN 1 AND 100`, append-only triggers, `ATTENDANCE_AWARDS_PER_DAY =
3`, and the `play_session_checkins_only_qr_scores` CHECK. The invariant a new
  mechanic must not break: **"nothing in the anti-abuse layer refuses a check-in.
  Attendance is a fact and is always recorded; only the payment stops."**
- **Bulgarian share-card text must come from `messages/*.json`** — the
  hardcoded-Cyrillic gate has an intentionally empty allowlist and scans every
  file under `app/`, `components/`, `lib/`.
- **Ops ceiling**: prod is `node:24-alpine` with **no Chromium and no system
  fonts**. `next/og` (satori + resvg wasm, explicit font buffers) is the safe
  path; `sharp`-rendered SVG `<text>` would resolve fonts through fontconfig and
  render **tofu in production while passing every local test**.
  ⚠️ **Implementation note:** the Docker web target copies only
  `.next/standalone`, `.next/static` and `public/` — the `@fontsource` `.woff`
  files live in `node_modules` and must be explicitly traced
  (`outputFileTracingIncludes`) or copied into `public/`, or share-card rendering
  will fail in prod only.
- **Push is email + PWA only.** iOS Web Push requires iOS 16.4+ **and** Home
  Screen installation — two sequential opt-ins, each shedding audience. Email and
  in-app remain the reliable channels. Frequency discipline is not optional:
  1 push/day → 88% 3-month retention; 3/day → 71%; 5/day → **54%** (Airship).

---

## 5. Suggested sequencing

1. **Instrument first** (C1) — one week, near-zero cost, tells you which cards to build.
2. **Tier A in full** — this is the biggest ratio of felt-impact to work in the plan, and it is all surfacing of tested machinery.
3. **B1 (Local Legend) + C2 (OG images)** — the two highest-ceiling single features: one creates a defendable identity tied to a place, the other makes every existing page shareable.
4. **B2 divisions + A4 streak freeze** — the retention core, once there is enough weekly activity for 30-person groups to be meaningful.
5. **C5 recap + B4 city vs city** — seasonal, high-visibility, sponsor-friendly.
6. **D2 organiser unlock (ROADMAP 4.7)** — converts competition into supply.

Two evidence-based cautions on expectations: the JMIR 2025 meta-analysis of
gamification for ages 6–18 (16 RCTs, n=7,472) found interventions **>12 weeks**
worked (SMD 0.14) while **≤12 weeks did nothing** (SMD 0.02) — this is a
multi-season programme, not a launch stunt. And the largest moderator by far was
**Self-Determination-Theory-based design** (SMD 0.39): autonomy, competence and
relatedness beat points-and-badges. SportKarta starts with Epic Meaning for
free — an NGO mapping free public sport in a country where most people do none.
