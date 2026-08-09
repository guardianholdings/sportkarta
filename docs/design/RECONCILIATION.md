# Seed reconciliation — "Повече от просто спорт" design handoff ↔ SportKarta

**Status:** PART A (inventory + reconcile). **No code written.** Two approval gates at the end
(§5.A category system, §5.B conflict resolutions) must clear before PART B.

The seed is the **design authority**. Where it specifies (palette, type, spacing, radii, shadows,
motion, component contracts, voice) it wins. Where it is silent, decisions below are marked
**[derived]**.

---

## 0. Where the handoff actually is (read this first)

The prompt points at `docs/design/design_handoff_sports_map_platform/` **inside the working repo**
(`/Users/GuardianG/Claude/Projects/sportnakarta`). It is **not there.** The full bundle lives in a
**separate, uncommitted git repo**:

```
/Users/GuardianG/sportkarta/docs/design/design_handoff_sports_map_platform/
```

`/Users/GuardianG/sportkarta` is a delivery drop — a git repo with **zero commits**, containing only
`docs/ROADMAP.md` + `docs/design/`. The working repo is the real codebase (all 30 feature commits).
All of PART A below was read from the sibling path. **See conflict C1** — the bundle must be copied
into the working repo before PART B so the authority is version-controlled alongside the code.

Filename drift also found (C3): prompt says `Platform_dc.html`, actual is **`Platform.dc.html`**;
manifest says `readme.md` / `SKILL.md`, actual is **`README.md`** and **no `SKILL.md`**.

---

## 1. Inventory — claimed vs. present

`README.md` §Files and `DESIGN_SYSTEM.md` §6 (manifest) describe the bundle. Reality:

| Manifest claims                | Present?                       | Notes                                                                                                                                                                                             |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `styles.css`                   | ✅                             | 8 `@import` lines only, as described.                                                                                                                                                             |
| `README.md` (`readme.md`)      | ✅                             | Case differs; harmless.                                                                                                                                                                           |
| `DESIGN_SYSTEM.md`             | ✅                             |                                                                                                                                                                                                   |
| `SKILL.md`                     | ❌ **absent**                  | "makes this a downloadable Claude Skill" — never delivered. Non-blocking.                                                                                                                         |
| `tokens/` (8 files)            | ✅ **all 8**                   | `fonts, colors, typography, spacing, radius, elevation, motion, base`. **Present and complete** — contradicts the prompt's "if missing or partial" premise. See C2.                               |
| `components/` (13 primitives)  | ✅ **all 13**                  | Each has `.jsx` + `.d.ts` + `.prompt.md`, grouped `actions/ forms/ data-display/ navigation/ map/`. Plus per-group `*.card.html` specimen files.                                                  |
| `guidelines/` (specimen cards) | ✅ 14 HTML files               | type-{display,headings,body,mono}, colors-{category,clay,pine,neutrals,semantic}, spacing-scale, radius-scale, elevation-shadows, motion-easing, brand-{motif,wordmark}.                          |
| `ui_kits/platform/`            | ❌ **absent**                  | "high-fidelity screen recreations" — **not delivered.** Screen-level fidelity therefore comes only from `README.md` §Screens prose + `Platform.dc.html`. This is the single biggest fidelity gap. |
| `assets/`                      | ❌ **absent**                  | imagery placeholders + type lockup. No logo, no photography (both explicitly "do not invent").                                                                                                    |
| `Platform.dc.html`             | ✅                             | 84 KB self-contained prototype.                                                                                                                                                                   |
| `support.js`                   | ✅ (undeclared as deliverable) | 66 KB in-house template runtime. **Do not ship** (README says so).                                                                                                                                |

**Bottom line:** the token layer and component contracts — the parts PART B needs — are **fully
present**. The two absent items (`ui_kits/`, `assets/`) are visual references and brand assets, not
implementable contracts; their absence is worked around by the prototype + prose, not reconstructed.

---

## 2. Token recovery

The prompt's recovery procedure assumes `tokens/` may be missing/partial and says to rebuild from the
two fallbacks (README table, prototype `:root`), README winning on conflict. **`tokens/` is present
and is a strict SUPERSET of both fallbacks** — so it is used verbatim as the source of truth; the
fallbacks only _corroborate_ it. I diffed all three anyway.

### 2.1 Three-way agreement — every shared value is identical

Checked every value that appears in ≥2 of {`tokens/*.css`, README §Design Tokens table, prototype
`:root`}: neutrals, pine ramp, clay ramp, all 7 category colors, success/warning (+bg/+border),
radii (md/lg/xl/pill), all 5 shadows, motion durations + `--ease-out`, spacing/containers.
**No value-level disagreement anywhere.** README does not "win" over anything because nothing
conflicts. (So the flag-every-discrepancy step yields the presence/absence deltas below, not value
deltas.)

### 2.2 What `tokens/` has that the fallbacks omit (superset deltas — not conflicts)

- **Pine ramp:** tokens add `--pine-400 #4E9E70`, `-800 #163E2B`, `-900 #132F22` (README lists only 50/100/200/300/500/600/700).
- **Clay ramp:** tokens add `--clay-50 #FBF0E4`, `-100 #F7E1C9`, `-400 #E28C3C`, `-700 #9C4E1B`.
- **Sky ramp** (`--sky-100/300/500/700`) — not in README table at all; feeds `--info`.
- **Full semantic set:** `--danger #CE4A38`(+bg/border), `--info #3E8FC9`(+bg/border) — README table documents only success + warning, though `DESIGN_SYSTEM.md §3.1` describes danger(rust) + info(glacier). tokens/ is authoritative.
- **Semantic aliases** (the "use these in product code" layer): `--color-bg/-surface/-surface-2`, `--text-primary/-secondary/-tertiary`, `--text-on-brand/-on-accent`, `--brand-active/-subtle/-subtle-hover/-border`, `--accent-active/-subtle/-border`, `--line/-strong`, `--focus-ring(-accent)`, `--link(-hover)`, `--overlay-scrim`.
- **Radius:** tokens add `--radius-xs 6`, `-sm 8`, `-2xl 28`, `-circle 50%`.
- **Elevation:** tokens add `--shadow-xl`; ring tokens `--ring`/`--ring-accent`.
- **Motion:** tokens add `--ease-standard/-in/-trail`, `--dur-micro/-slow/-page`. **`--ease-trail = cubic-bezier(0.34, 1.4, 0.64, 1)`** (the overshoot; README/DESIGN_SYSTEM only prose-describe it).
- **Typography:** tokens define the whole scale as role tokens (`--fs-*`, `--lh-*`, `--ls-*`) + utility classes (`.t-display-*`, `.t-h*`, `.t-body*`, `.t-overline`, `.t-data`). README gives only "observed sizes."

### 2.3 The one token file that is NOT usable as-is

`tokens/fonts.css` `@import`s **Google Fonts over the network** and its own comment says "If you
self-host for production, replace this `@import` with local `@font-face`." Our stack takes **no
external runtime dependencies** → this file is rewritten in PART B (self-host), not copied. Every
other token file copies verbatim. See **C14**.

**Recovery verdict:** no reconstruction required. PART B copies `tokens/{colors,typography,spacing,radius,elevation,motion,base}.css` verbatim and rewrites only `fonts.css`.

---

## 3. Category re-map — 29 canonical sports → seed trail-blaze family

**The core mismatch.** The seed defines **7** categories (`--cat-hike/run/bike/climb/swim/team/
calisthenics`). Our real vocabulary is **`lib/src/sports.ts` → `CANONICAL_SPORTS` = 29 sports**
(archery, athletics, badminton, basketball, beach_volleyball, bmx, calisthenics, chess, climbing,
cycling, equestrian, fitness, football, gymnastics, handball, hiking, hockey, ice_skating,
martial_arts, multi, petanque, running, shooting, skateboard, squash, swimming, table_tennis,
tennis, volleyball). Seven colors cannot be one-to-one with 29 sports.

### 3.1 Mapping principle **[derived]**

> **Color encodes the broad activity family; the Lucide icon + the (always-present) text label encode
> the specific sport.** This is exactly the seed's own model — `DESIGN_SYSTEM.md §4`: "Category
> meaning = icon + color, always paired with a text label." The seed itself uses only ~6 glyphs for 7
> categories. We bias toward **few colors** ("a _controlled_ trail-blaze set") and let the glyph do
> the fine work.

Two seed category colors literally equal ramp steps (`--cat-hike` = `--pine-500`, `--cat-bike` =
`--clay-400`), confirming the palette is one warm-natural family — new members must sit in the same
**mid-chroma, medium-lightness** band (observed S≈46–75%, L≈33–59%).

### 3.2 Families: **7 seed + 2 derived + 1 neutral**

| Family              | Color token          | Hex       | Origin        | Sports                                                                    |
| ------------------- | -------------------- | --------- | ------------- | ------------------------------------------------------------------------- |
| Trail               | `--cat-hike`         | `#2E7D55` | seed          | hiking, **equestrian**†                                                   |
| Run                 | `--cat-run`          | `#E15A4A` | seed          | running, **athletics**                                                    |
| Wheels              | `--cat-bike`         | `#E28C3C` | seed          | cycling, **bmx**, **skateboard**                                          |
| Climb               | `--cat-climb`        | `#BB5A2E` | seed          | climbing                                                                  |
| Water               | `--cat-swim`         | `#3E8FC9` | seed          | swimming, **ice_skating**†                                                |
| Team / ball         | `--cat-team`         | `#6E5CC4` | seed          | football, basketball, volleyball, beach_volleyball, handball, **hockey**† |
| Body / gym          | `--cat-calisthenics` | `#2E9EA0` | seed          | calisthenics, fitness, gymnastics, **martial_arts**                       |
| **Racket / net**    | `--cat-racket`       | `#BF638D` | **[derived]** | tennis, table_tennis, badminton, squash                                   |
| **Precision / aim** | `--cat-precision`    | `#5C738A` | **[derived]** | archery, shooting, petanque, chess                                        |
| **Multi (neutral)** | `--cat-multi`        | `#6E7268` | **[derived]** | multi                                                                     |

**Derived-color justifications** (each sits in the mid-chroma band; HSL given to prove it):

- **`--cat-racket #BF638D`** — HSL ≈ (333°, 42%, 57%). Racket/net sports are neither team (they're
  1v1/2v2) nor gym; folding tennis into violet would misread it. A dusty berry-rose fills the empty
  magenta arc (no seed hue is between violet 250° and coral 6°) and stays earthy, not neon —
  bilberry, a Bulgarian-mountain reference. **Widely-built facility type (tennis courts) → earns its
  own blaze.**
- **`--cat-precision #5C738A`** — HSL ≈ (210°, 22%, 45%). Aim/strategy sports are low-motion and
  "steady"; a desaturated steel-slate reads _instrument/target_. Chroma is **deliberately dropped**
  vs. the vivid families so it feels calm. ⚠ It is bluish like glacier-swim (`#3E8FC9`) — separated
  by chroma only; **must be validated on-map for distinctness (incl. deuteranopia) in PART B** (see
  C11).
- **`--cat-multi #6E7268`** — a warm neutral, ~8% sat. A multi-sport facility isn't one activity;
  rendering it in any blaze color would falsely imply a single sport. Neutral = "mixed." Not really a
  blaze — the intentional absence of one.

**† Judgment calls (color = broad _feel/where_, not surface):**

- **equestrian → Trail (pine):** outdoor, trail-based, nature — same family as hiking. (Also: Lucide
  has no horse glyph — see gap list.)
- **ice_skating → Water (glacier):** gliding on frozen water; icon `Snowflake` carries the winter
  read. Avoids minting an "ice" color for one sport.
- **hockey → Team (violet):** grouped by _social structure_ (a team match), not by ice surface. Icon
  disambiguates from field team sports.
- **martial_arts → Body/gym (teal):** mat/hall body-discipline, like gymnastics; icon `Swords`.

### 3.3 Per-sport icon table (29 rows) — Lucide proposals

Icons are **proposed**; each is **verified against the installed `lucide-react` in PART B**, and any
missing name is replaced by the nearest existing glyph **or** a custom SVG drawn in the seed stroke
style (§3.4). ⚠ = Lucide has no faithful glyph today.

| Sport            | Color token          | Proposed Lucide icon                    |
| ---------------- | -------------------- | --------------------------------------- |
| hiking           | `--cat-hike`         | `Mountain`                              |
| equestrian       | `--cat-hike`         | ⚠ `Route` (no horse glyph)              |
| running          | `--cat-run`          | `Footprints`                            |
| athletics        | `--cat-run`          | `Timer`                                 |
| cycling          | `--cat-bike`         | `Bike`                                  |
| bmx              | `--cat-bike`         | `Bike` (shares; label disambiguates)    |
| skateboard       | `--cat-bike`         | ⚠ `Skateboard` if present, else nearest |
| climbing         | `--cat-climb`        | `Triangle` (the seed's own choice)      |
| swimming         | `--cat-swim`         | `Waves`                                 |
| ice_skating      | `--cat-swim`         | `Snowflake`                             |
| football         | `--cat-team`         | `Goal`                                  |
| basketball       | `--cat-team`         | ⚠ `Dribbble` (nearest)                  |
| volleyball       | `--cat-team`         | `Volleyball`                            |
| beach_volleyball | `--cat-team`         | `Volleyball` (shares)                   |
| handball         | `--cat-team`         | ⚠ `Users` (no handball glyph)           |
| hockey           | `--cat-team`         | ⚠ `Users` (no hockey glyph)             |
| calisthenics     | `--cat-calisthenics` | `Dumbbell` (the seed's own choice)      |
| fitness          | `--cat-calisthenics` | `HeartPulse`                            |
| gymnastics       | `--cat-calisthenics` | ⚠ `PersonStanding`                      |
| martial_arts     | `--cat-calisthenics` | `Swords`                                |
| tennis           | `--cat-racket`       | ⚠ no racket glyph → custom              |
| table_tennis     | `--cat-racket`       | ⚠ custom                                |
| badminton        | `--cat-racket`       | ⚠ custom                                |
| squash           | `--cat-racket`       | ⚠ custom                                |
| archery          | `--cat-precision`    | `Target`                                |
| shooting         | `--cat-precision`    | `Crosshair`                             |
| petanque         | `--cat-precision`    | ⚠ `CircleDot` (nearest)                 |
| chess            | `--cat-precision`    | ⚠ `Crown` (nearest) or custom           |
| multi            | `--cat-multi`        | `Shapes`                                |

### 3.4 Lucide coverage gap **[derived decision — needs approval]**

Lucide is a general line set, not a sports pictogram library. Sports with **no faithful glyph**:
`equestrian, skateboard, tennis, table_tennis, badminton, squash, handball, hockey, petanque, chess`.
Proposed policy: for these, draw **custom SVGs to the seed's icon contract — single 1.75px stroke,
rounded joins, 24px box, `currentColor`, no fill** — and store them beside the Lucide imports so the
map/chip/marker code treats them identically. Where a custom glyph isn't worth it, the family glyph +
text label suffices (the seed permits this). **Decision for you:** custom glyphs for all 10, or only
the high-traffic ones (tennis, hockey), rest inherit family glyph?

---

## 4. Scope gap matrix

Every ROADMAP surface (routes enumerated from `apps/web/app/[locale]/**`) classified **DESIGNED**
(seed drew this screen) / **ADJACENT** (extends a named seed pattern) / **UNDESIGNED** (seed never
anticipated → derive).

### DESIGNED — a direct seed screen exists

| Surface (route)                                       | Seed screen                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/vhod`, `/admin/login` (auth/OTP)                    | Onboarding / Login (§0) — two-pane, provider buttons, OTP field                                                                                                                       |
| Global app shell (sidebar + top bar)                  | App shell (§1) — 236px sidebar, 68px top bar, brand lockup, user row                                                                                                                  |
| `/` + map discovery + `/igrishta`, `/igrishta/[city]` | Map discovery (§2) — list panel · map canvas · view switch                                                                                                                            |
| `/obekt/[slug]` (facility detail)                     | Spot detail panel (§2) — hero, stat block, elevation profile, amenities, reviews, footer CTA                                                                                          |
| `/klasirane` (leaderboards)                           | Competitions / Leaderboard (§4) — podium, rows, "You" badge, period control                                                                                                           |
| `/pasport/[handle]`, `/profil`                        | Profile (§5) — avatar header, 4-up stats, badge grid, tabbed history                                                                                                                  |
| _(seed) Activity feed (§3)_                           | **Seed-only, no product counterpart** — we have no social feed; the weekly city page + digest replace it. Reuse the feed's post-card/composer patterns only if a feed is ever scoped. |

### ADJACENT — extends a named seed pattern

| Surface                                                         | Extends                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map layer: MapLibre style, markers, trails, clustering, near-me | Seed `MapMarker` (teardrop, cat color, white glyph, 36/40/44), near-me radius, hover-sync, cluster bubble, GPS polylines. Reconcile existing `map-canvas.tsx`/"green-only trails" to the seed marker spec.                        |
| `/dobavi` (add-a-spot)                                          | Seed forms + category **Chip** picker + photo/pin; DESIGN_SYSTEM lists "Add-a-spot" as a core surface but ships no dedicated screen spec.                                                                                         |
| `/sesiya/[occurrenceId]`, `/sesiya/.../qr`, `/kalendar`         | Card/Badge/Stat/detail; feed's "Event" badge + spot-detail RSVP footer hint at sessions. **`/qr` (item 4.3, next-up)** is server-rendered SVG (no client JS) — mostly derived, styled via tokens.                                 |
| `/kampanii`, `/kampanii/[slug]`, `.../rezultati`                | Leaderboard §4 "Active challenges" grid + progress bars + reward badges.                                                                                                                                                          |
| `/obshtina/[city]`, `/api/widget/*`                             | Stat/Card/Badge data-report layout. **Widget constraint:** `script-src 'none'`, no external request, inline CSS — it **cannot** consume the design system's CSS-var tokens or webfonts; needs a hex-resolved inline style subset. |
| `/statistika`, `/api/stats`                                     | Stat/Card + existing `bar-chart`; mono figures.                                                                                                                                                                                   |
| `/sedmitsata/[city]` + digest email                             | Card/Stat. **Email constraint:** table layout + inlined hex (no CSS vars, no webfonts) — needs a hex-resolved token export.                                                                                                       |
| `/danni`, `/danni/klyuchove`, `/danni/litsenz`                  | Typography + Card/Badge + data tables (docs/portal).                                                                                                                                                                              |

### UNDESIGNED — seed never anticipated; derive from primitives

| Surface                                                                                                                                                                                                                                            | Note                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entire `/admin/(protected)/*` console** — ambasadori, facilities(+`/[id]` edit), import(+`/[jobId]`), kampanii CRUD(+nova/[slug]), moderation, obshtini (municipal CSV inbox), otcheti (reports), rezultati(+[occ]), sesii (bulk-create), verify | **Biggest gap.** The seed is a public/member app; there is no admin/data-ops pattern. Derive a dense admin layout (tables, forms, Stat, Badge, SegmentedControl) — same tokens, different density. |
| **ММС grant + quarterly reports** (`/admin/otcheti`, print HTML→PDF)                                                                                                                                                                               | Ministry-format documents; per CLAUDE.md deliberately **outside next-intl** (hardcoded Cyrillic field names), print-oriented. Seed has no report/print design.                                     |
| **Transactional emails** (OTP, RSVP, T-24h/T-2h, digest, cancellation)                                                                                                                                                                             | Need inlined-hex, table-based HTML. Seed has no email design.                                                                                                                                      |
| `/privacy`, `/danni/litsenz` content, `/otmetka/[token]`, `/sedmitsata/otpisvane/[token]`, `/kalendar/*` token pages                                                                                                                               | Small utility/content/confirm pages; typography primitives only.                                                                                                                                   |
| Error/empty/loading/404 states across all of the above                                                                                                                                                                                             | Seed gives voice/copy rules (§2) but no state screens.                                                                                                                                             |

---

## 5. Conflicts — nothing resolved silently

Each has a **recommended resolution**; ★ = needs your explicit sign-off (bundled into the two gates).

| #         | Conflict                                                                                                                                                                                                                                                                                                                                                       | Recommended resolution                                                                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1 ★**  | **Handoff is not in the working repo** — it lives in the uncommitted sibling `/Users/GuardianG/sportkarta`. Nothing here is version-controlled with the code.                                                                                                                                                                                                  | Copy the whole bundle into the working repo at `docs/design/design_handoff_sports_map_platform/` (read-only authority) and commit it in PART B. PART A read from the sibling.                                                                                                                              |
| **C2**    | Prompt premise (styles.css "@import only"; reconstruct tokens "if missing/partial") vs. reality: `tokens/` is **present and a superset** of both fallbacks; no value disagreements.                                                                                                                                                                            | Skip reconstruction. Copy `tokens/*.css` verbatim (except `fonts.css`, C14). §2 records the (zero) value deltas + superset additions.                                                                                                                                                                      |
| **C3**    | Filename drift: `Platform_dc.html`→`Platform.dc.html`; `readme.md`/`SKILL.md`→`README.md`/absent.                                                                                                                                                                                                                                                              | Trust the filesystem; docs use real names.                                                                                                                                                                                                                                                                 |
| **C4**    | Manifest claims `ui_kits/platform/`, `assets/`, `SKILL.md` — **all absent**.                                                                                                                                                                                                                                                                                   | Treat as not delivered. Screen fidelity from README prose + prototype. Logo/photography stay unbuilt (seed says do not invent) — keep the Manrope-800 type wordmark.                                                                                                                                       |
| **C5 ★**  | **Current `apps/web/app/globals.css` is the stock shadcn grayscale scaffold** — `--primary: oklch(0.205 0 0)` (near-black), white `--background`, shadcn names (`--card/--muted/…`). **None** of it is the seed.                                                                                                                                               | Replace the token layer wholesale with seed tokens; keep the Tailwind v4 `@theme` _mechanism_, redefine its contents.                                                                                                                                                                                      |
| **C6 ★**  | **Dark mode.** Seed is **light-mode-only**; current globals.css ships `@custom-variant dark` + a full `.dark` block; `viewport.themeColor` is teal `#0f766e`. App has **0** `dark:` usages (dead scaffold).                                                                                                                                                    | Remove the dark variant + `.dark` block. Set `themeColor` to brand pine `#216543` (or paper `#FBF9F3`). Ship light-only.                                                                                                                                                                                   |
| **C7 ★**  | **Radius namespace collision.** Seed radii: sm8/md10/lg14/xl20/pill999. Tailwind v4 `@theme` currently derives `--radius-md/lg/xl` from `--radius:0.625rem` → md8/lg10/xl14, so `rounded-lg` ≠ seed `--radius-lg`.                                                                                                                                             | Overwrite Tailwind's `--radius-*` with the seed values and add explicit aliases (`rounded-card`=lg, `rounded-sheet`=xl, `rounded-pill`). One-time audit of existing `rounded-*` usages during PART B.                                                                                                      |
| **C8**    | Existing `components/ui/button.tsx` (shadcn: `rounded-md`, `h-9`=36px < 44 min, grayscale, `default/destructive/outline/secondary/ghost/link`) contradicts the seed Button contract (pill, sm36/md44/lg52, `primary/accent/secondary/ghost/danger`, iconLeft/Right). It is an **orphan** (no imports found in `app/`).                                         | Replace with the seed contract; keep `cva`+`cn`+Radix Slot infra.                                                                                                                                                                                                                                          |
| **C9**    | Category colors overlap brand/accent: `--cat-hike #2E7D55`≈`--brand #216543`; `--cat-bike #E28C3C`≈`--accent #D5762A`. Tension with "one clay accent per view" (amber bike markers on the map).                                                                                                                                                                | Seed-intentional (palette is one family). Enforce "one accent moment" **per non-map view**; forbid clay chrome on the map screen where amber markers live. Document.                                                                                                                                       |
| **C10**   | Three warm reds crowd a narrow band: `--danger #CE4A38`, `--cat-run #E15A4A`, `--cat-climb #BB5A2E`. Hue alone is weak on a busy map.                                                                                                                                                                                                                          | Rely on icon+label (already mandatory). Keep `--danger` for **status only** (never a marker). Contrast-check run vs climb markers in PART B.                                                                                                                                                               |
| **C11**   | Derived `--cat-precision #5C738A` is bluish like `--cat-swim #3E8FC9` (separated by chroma only).                                                                                                                                                                                                                                                              | Validate on-map distinctness incl. deuteranopia in PART B; if weak, shift precision toward warm stone. **Open until validated.**                                                                                                                                                                           |
| **C12 ★** | **Icons: CDN vs self-host + coverage gaps.** Seed loads Lucide from `unpkg` CDN; our stack allows **no external runtime deps**. Also 10 sports have no faithful Lucide glyph (§3.4).                                                                                                                                                                           | Install `lucide-react` locally (PART B item 7). Custom-glyph policy per §3.4 — **your call** on scope of custom SVGs.                                                                                                                                                                                      |
| **C13**   | Icon stroke width inconsistency: DESIGN_SYSTEM §4/§5 says **1.75px**; README Assets says "~1.75–2px"; Lucide default is 2px.                                                                                                                                                                                                                                   | Pin **1.75px** app-wide (the specific, twice-stated value) via a Lucide default-props wrapper.                                                                                                                                                                                                             |
| **C14 ★** | **Fonts: CDN vs self-host.** `tokens/fonts.css` `@import`s Google Fonts. We need self-hosted, Cyrillic-verified, weight-subset, license-cleared Manrope + JetBrains Mono.                                                                                                                                                                                      | PART B item 7: self-host via `next/font/local`; verify Cyrillic subset present in the files; subset to declared weights (Manrope 400/500/600/700/800, JBM 400/500/600/700); confirm **SIL OFL** allows self-hosting. `fonts.css` is the **only** token file rewritten, not copied.                         |
| **C15**   | The **data=mono / everything-else=sans** split (a hard seed rule) is not honored by existing `stats-table`, `bar-chart`, leaderboard components (they predate the seed).                                                                                                                                                                                       | Bake the split **into the primitives** (Stat/Badge/Chip value slots force `--font-mono`; the rest `--font-sans`), then reconcile existing stats components. Enforced in components, not by convention (per the prompt's binding rule).                                                                     |
| **C16**   | i18n vs. seed hardcoded strings + reports carve-out. Seed examples hardcode Bulgarian; our rule = every string via next-intl (bg source, parity + hardcoded-Cyrillic gate, `apps/web/tests/i18n*.test.ts`). But **reports deliberately keep Bulgarian field names OUT of i18n**. New hex/px CI gate (item 6) must not collide with the existing Cyrillic gate. | All primitive/screen strings → next-intl (bg+en). Reports stay carved out (existing allowlist). Scope the new hex/px gate to component/style files so it doesn't fight the Cyrillic gate or the reports catalogue.                                                                                         |
| **C17**   | Architecture: seed is a single client component with local state + no routing; we are App-Router RSC, `[locale]`-segmented, server-first.                                                                                                                                                                                                                      | Not a real contradiction — README already says "implement real routes." Adopt the seed's _visual_ shell as a server layout; interactive map bits (hover-sync, filters, elevation scrub, recorder) become client islands; README state table → URL/searchParams + local state. Document as the translation. |
| **C18**   | Warm-hue crowding (minor): `--warning #C9891F` sits near `--accent #D5762A`.                                                                                                                                                                                                                                                                                   | Warning = status only; accent = CTAs. Both documented; low priority (subsumed by C9/C10 discipline).                                                                                                                                                                                                       |

---

## 5.A — GATE 1: category system (needs approval before any code)

1. Mapping principle: **color = family, Lucide icon + text label = specific sport** (§3.1).
2. Families: **7 seed + 2 derived + 1 neutral** (§3.2), with derived `--cat-racket #BF638D`,
   `--cat-precision #5C738A`, `--cat-multi #6E7268`.
3. The four judgment folds: equestrian→Trail, ice_skating→Water, hockey→Team, martial_arts→Body (§3.2 †).
4. The 29-row sport→color→icon table (§3.3).
5. Custom-glyph policy for the 10 Lucide gaps (§3.4) — **all 10, or high-traffic only?**

## 5.B — GATE 2: conflict resolutions (needs approval before any code)

Sign-off requested specifically on the ★ items — **C1** (copy bundle into repo), **C5** (replace
shadcn tokens), **C6** (remove dark mode), **C7** (overwrite Tailwind radius scale), **C12** (local
Lucide + custom-glyph scope), **C14** (self-host fonts) — and acknowledgement of the recommended
resolutions for the rest. **C11** (precision vs. glacier) stays open pending a PART B contrast check.

---

_PART A ends here. On approval of GATE 1 + GATE 2, PART B implements: token layer + Tailwind theme +
hex/px CI gate, self-hosted fonts + local Lucide, the 14 primitives, and a `/design-system` route._
