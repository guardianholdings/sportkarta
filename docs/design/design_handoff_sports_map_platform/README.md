# Handoff: Bulgarian Sports Map Platform ("Повече от просто спорт")

## Overview

A **map-first web platform** where young, active people in Bulgaria discover places for outdoor & sport activities, add their own spots, log visits, join clubs, attend events, and compete on leaderboards and challenges. The map of Bulgaria is the home screen; everything (spots, activity feed, leaderboards, profile) layers on top of or beside it.

This bundle covers the full authenticated app plus onboarding: **Onboarding/Login → Map discovery (list + map canvas + spot detail) → Activity feed → Competitions/Leaderboard → Profile**, and five interactive behaviors that make the map genuinely useful (hover-sync, elevation scrubbing, live filters, near-me radius, activity recorder).

The UI is **bilingual (Bulgarian primary / English fallback)** and **light-mode only**. Copy in the prototype is Bulgarian; English equivalents are given throughout this document and in the design-system readme.

---

## About the design files

The files in this bundle are **design references created in HTML** — a working prototype that demonstrates the intended look, layout, and interaction behavior. **They are not production code to copy line-for-line.**

Your task is to **recreate these designs in the target codebase's environment**, using its established framework, component library, and patterns. If no codebase exists yet, choose the most appropriate stack for a map-first responsive web app (the design system ships React `.jsx` reference components, so React + a mapping SDK like MapLibre/Mapbox GL is a natural fit) and implement there.

Concretely:
- `Platform.dc.html` is a self-contained prototype built on a small in-house template runtime (`support.js`). **Do not ship the runtime.** Read it to understand structure, state, and interactions, then rebuild with real components.
- The **map is a placeholder** (a static SVG grid with fake pins). In production, replace it with a real map SDK; the prototype documents how markers, the near-me radius, and hover-sync should behave on top of it.
- All **imagery is placeholder** (striped fills labeled in mono). Drop in real photography of Bulgarian landscapes, trails, coast, and people being active.
- Consume the **design tokens** (`styles.css` + `tokens/`) as CSS custom properties — never hard-code the hex values.

## Fidelity

**High-fidelity (hifi).** Colors, typography, spacing, radii, shadows, and interaction states are final and intentional. Recreate the UI to match — exact values are documented below and defined as tokens in `tokens/`. The one deliberate exception is the map surface and all photography, which are placeholders to be replaced with a real map SDK and real images.

---

## Screens / Views

The app shell is a **fixed full-viewport layout**: a left sidebar (nav) + a main column (top bar + screen body). Four primary screens swap in the main column; onboarding is a full-screen overlay shown when logged out.

### 0. Onboarding / Login (logged-out overlay)
- **Purpose:** Sign in or create an account; sell the community.
- **Layout:** Two panes, full viewport. Left pane `flex:1`, deep-forest background (`#1A3E2B`) with two radial glows (pine + clay) and a faint 40px white graticule grid; 56px padding; content top-and-bottom justified. Right pane fixed `452px`, centered form, 48px padding, `--paper` background.
- **Left pane content:** mono overline "BG · Outdoor" in clay; display headline 46px/800/-.03em white ("Открий, изкачи, посрещни хора навън." / "Discover, climb, meet people outside."); 17px subhead at 80% white; a row of three mono stats (2 400+ places · 38 000 active people · 7 sports).
- **Right pane content:** mono eyebrow (clay) + 27px/800 heading "Влез в общността" / "Join the community"; three provider buttons (Email, Google, Apple) — 48px tall, pill, `--surface` fill, `--border-strong` hairline, left-aligned icon+label; an "или/or" divider; an email field (44px, `--radius-md`); a primary "Влез/Sign in" button (48px pill, `--brand` fill, white, arrow icon); 12px muted legal line.
- **Behavior:** any button calls `login()` → sets `authed:true` → reveals the app.

### 1. App shell (persists across screens 1–4)
- **Sidebar** — width `236px`, `--surface`, right hairline, `20px 16px` padding, 4px vertical gaps.
  - Brand lockup (top): mono overline "BG · Outdoor" (clay, 10px, .14em, uppercase) + stacked wordmark "Повече от / просто спорт" (Manrope 800, 17px, -.02em).
  - Nav list (4 items): Карта/Map, Емисия/Feed, Класации/Leaderboards, Профил/Profile. Each 44px tall, `--radius-md`, icon (20px) + label, gap 12px. Active = `--pine-50` fill + `--pine-700` text; inactive = transparent + `--text-secondary`.
  - Spacer, then "Добави място/Add a spot" button — 44px pill, `--accent` fill, white, plus icon.
  - User row (bottom): 40px circular avatar (initials "ТА", pine tint, 2px brand ring) + name "Ти Активния" + mono "1 240 km · 3-ти" + logout icon (calls `logout()`).
- **Top bar** — height `68px`, `0 24px` padding, bottom hairline, `--surface`. Screen title (Manrope 700, 21px, -.02em) on the left; spacer; two 44×44 icon buttons (bell, bookmark) — `--radius-md`, `--border-strong` hairline.
  - Titles per screen: map "Открий места", feed "Емисия", compete "Състезавай се", profile "Профил".

### 2. Map discovery (screen: `map`) — the home screen
Three columns inside the main body: **list panel · map canvas · (optional) spot-detail panel**.

- **List panel** — width `384px`, `--paper`, right hairline, column.
  - **Sticky filter header** (bottom hairline, 16–18px padding, 12px gaps):
    - Search field — 44px, `--radius-md`, search icon + placeholder "Търси място, връх, дейност…".
    - Category filter chips — horizontal scroll row, 7 chips (one per category), 36px pill each: icon (in the category color) + label. Selected chip = tinted fill + colored border/text (`color-mix` 14% of category color); unselected = `--surface` + `--border-strong`. Multi-select, toggles.
    - **Distance slider** — mono label "Дист. ≤ {n} км" (min-width 96px) + range input (1–30, step 1; 30 shows "30+ км").
    - **Difficulty segmented control** — mono label "Трудност" + 4-button pill group (Всички/All, Лесно/Easy, Умерено/Moderate, Трудно/Hard); active button = `--surface` fill + `--shadow-sm` + `--pine-700`.
    - **Near-me toggle** — 30px pill "В близост/Nearby"; when on, fills `--accent`/white and reveals a radius label (mono "{n} км") + range input (3–30, step 1).
  - **Result list** (scrolls): a row with mono count "{n} места · София и околност" + a "Сортирай/Sort" text button; then spot **cards** (14px gap).
    - **Spot card** — `--radius-lg`, `--surface`, `--shadow-sm`, `--border` hairline. Photo area 132px (striped placeholder) with: a heart button (32px circle, top-right), a mono "spot photo" label (top-left), and a category pill (bottom-left: color dot + label). Body (14–16px padding): name (Manrope 700, 17px), area (13px muted), a **meta line** (mono rating with clay star · difficulty · open/seasonal status dot), and a 3-up stat strip above a hairline (Дистанция/Distance, Изкачване/Ascent, Ревюта/Reviews — values in mono).
    - **States:** selected = brand border + brand ring + `--shadow-md` + `translateY(-1px)`; hovered = brand border + `--shadow-lg` + `translateY(-2px)`.

- **Map canvas** — `flex:1`, `#EAE7DC` base with a 44px graticule grid, two soft blurred "water/forest" blobs, and two dashed GPS polylines (pine + clay, rounded caps). A mono attribution chip bottom-right ("© OpenStreetMap · map SDK placeholder"). **Replace this entire surface with a real map SDK.**
  - **View switch** (top center) — pill segmented control: Карта/Map vs Списък/List. List view replaces the canvas with a responsive card grid (`repeat(auto-fill,minmax(240px,1fr))`).
  - **Markers** (map view) — one per shown spot, positioned by `x%`/`y%`, `translate(-50%,-100%)`, teardrop shape (`border-radius:50% 50% 50% 4px; rotate(45deg)`) in the category color with a 3px white border and a white category glyph. Sizes: 36px default, 40px hover, 44px selected (selected/hover get a soft colored outline). Entrance = "drop" keyframe with the trail overshoot ease. A static cluster bubble ("12") sits at 86%/40%.
  - **Floating controls** — bottom-right "Добави място/Add a spot" pill (accent); right-side zoom/locate/layers stack (44×44 each, `--shadow-float`).

- **Spot detail panel** (right, when a spot is selected) — width `436px`, `--surface`, left hairline, `--shadow-lg`, overlays the map's right edge.
  - Hero 224px (striped placeholder, "drop real imagery" label) with a 44px close button (top-right, calls `closeDetail()`) and a category pill (bottom-left).
  - Body (scrolls, 20px padding, 18px gaps): title (Manrope 800, 24px) + mono meta (area · coordinates · open/seasonal); a 3-up stat block on `--paper-sunk` (`--radius-lg`): Дистанция, Изкачване, rating★ + reviews; a "За мястото/About" description; the **elevation profile** (see Interactions); a row of amenity chips (dogs OK, parking, water); two recent reviews (avatar + name + mono ★ rating + text).
  - Footer (hairline top): primary "Запиши посещение/Log a visit" pill (brand, footprints icon) + two 44px icon buttons (navigation, share).

### 3. Activity feed (screen: `feed`)
- **Purpose:** Social feed of community activity.
- **Layout:** centered column, `max-width:640px`, 16px gaps, 24px page padding.
- **Composer** (top): avatar + a faux input "Сподели своята активност…/Share your activity…" + a 44px accent camera button.
- **Post cards** (`--radius-lg`, `--surface`, `--shadow-sm`): header (avatar + name + mono "action · category · time" + either an "Събитие/Event" accent badge or a more-menu); spot title; optional 260px photo; optional stat strip (Дистанция/Изкачване/Време); action bar (Like/Comment/Share — 40px pill buttons). **Like** toggles: fills `--warning-bg`/`--cat-run` and increments the count.

### 4. Competitions / Leaderboard (screen: `compete`)
- **Purpose:** Rankings by elevation climbed + active challenges.
- **Layout:** centered, `max-width:760px`, 24px padding.
- **Header:** mono overline "Класация · изкачени метри/Leaderboard · meters climbed" + 22px/800 title "София · Хайкинг"; a period segmented control (Седмица/Week · Месец/Month · Година/Year).
- **Podium:** three cards, center (1st) raised `translateY(-14px)` and larger (64px avatar, clay border) vs sides (52px). Each shows rank, name, mono meters.
- **Leaderboard rows:** rank number (mono) · avatar · name (the "Ти/You" row gets a pine "Ти/You" badge + pine-tinted row) · mono "{n} акт./activities" · mono meters. 
- **Active challenges:** 2-col grid of cards, each with title, mono progress ("6 / 10 завършени"), a reward/status badge, and a progress bar (accent or category color fill).

### 5. Profile (screen: `profile`)
- **Purpose:** The user's identity, stats, badges, and history.
- **Layout:** centered, `max-width:760px`, 24px padding.
- **Header:** 92px avatar (initials, brand ring) + mono handle/city overline + 26px/800 name + bio line + a "Редактирай/Edit" outline button (settings icon).
- **Stats:** 4-col grid of stat cards (Активности/Activities, Разстояние/Distance, Изкачване/Ascent, Класация/Ranking — ranking value in clay).
- **Badges:** "Значки · 4 от 6/Badges · 4 of 6"; responsive tile grid (`minmax(88px,1fr)`). Earned = colored ring + white glyph; locked = 50% opacity + lock icon.
- **Tabs:** segmented control (Активности/Activities · Добавени места/Added spots · Клубове/Clubs). Activities = list rows (category icon + name + mono stats); Added spots = card grid; Clubs = membership rows.

---

## Interactions & Behavior

**Global**
- **Navigation:** clicking a sidebar item sets `screen`; leaving `map` clears the selected spot. No routing in the prototype — implement real routes (`/map`, `/feed`, `/leaderboards`, `/profile`, `/spot/:id`).
- **Auth gate:** `authed:false` shows the onboarding overlay; `login()`/`logout()` flip it.
- **Hover:** darken fill one step (`--brand → --brand-hover`) or lift a card one shadow step, ~120–180ms. **Press:** `scale(0.97)` + darken. **Focus:** always-visible pine ring (never removed).
- **Motion:** entrances ease-out at `--dur-base`; the gentle-overshoot `--ease-trail` is reserved for delight only (marker drop, badge unlock). Core UI never bounces. Respect `prefers-reduced-motion`.

**The five signature map interactions** (rebuild these against the real map/data):

1. **Card ↔ marker hover sync.** Hovering a spot card highlights its map marker (grow + outline); hovering a marker highlights the card **and smooth-scrolls it into view** in the list. Implemented via a shared `hovered` spot id + per-card refs. (Do **not** use `scrollIntoView`; the prototype computes `scrollTop` and calls `box.scrollTo` — keep that approach.)

2. **Elevation profile scrubbing** (spot detail). An SVG area+line chart of the route's elevation. **Drag horizontally** (pointer events, `touch-action:none`, pointer capture) to move a vertical scrub line + dot; a live mono readout updates distance-along-route (`frac × totalKm`) and elevation (`baseM + e × ascentM`). `scrubFrac` (0–1) is the state; resets to ~0.34 on select. In production, feed a real elevation series.

3. **Live filters** (list panel). Category chips (multi-select), a distance-max slider, a difficulty-max segmented control, and the near-me radius **all compose** — a spot shows only if it passes every active filter. The mono result count reflects the filtered set in real time. Filter predicates live in `renderVals()`; port them to your data layer.

4. **Near-me radius.** Toggling "В близост/Nearby" draws a dashed accent radius circle centered on the user (fixed center in the prototype) and filters spots to those within `radiusKm` (3–30, adjustable via slider). Circle diameter is derived from the radius. In production, center on real geolocation and filter by real distance.

5. **Activity recorder.** A red circular FAB (bottom-left of the map) starts recording → a `setInterval` ticks every 1s, advancing elapsed time and simulated distance; a floating pill (bottom-center) shows live mono **time · km · pace (min/km)** with a pulsing red dot, plus **pause/resume** (⏸/▶) and **stop** (■) controls. Clear the interval on unmount. Replace the simulated tick with real GPS tracking.

---

## State Management

All state is local to the root component (prototype). Map these to your app/store/route layer:

| State | Type | Meaning / trigger |
|---|---|---|
| `authed` | bool | Logged in; toggled by `login()`/`logout()`. |
| `screen` | `'map'\|'feed'\|'compete'\|'profile'` | Active primary screen (→ route). |
| `selected` | spot id \| null | Open spot detail (→ `/spot/:id`). |
| `view` | `'map'\|'list'` | Map canvas vs card grid. |
| `active` | string[] | Selected category filter keys (multi). |
| `maxDist` | int 1–30 | Distance-max filter (km). |
| `diff` | int 0–3 | Difficulty-max filter (0 = all). |
| `nearMe` | bool | Near-me radius on. |
| `radiusKm` | int 3–30 | Near-me radius (km). |
| `hovered` | spot id \| null | Card↔marker hover sync. |
| `scrubFrac` | float 0–1 | Elevation scrub position. |
| `recording` / `paused` | bool | Recorder state. |
| `sec` / `km` | number | Live recorder elapsed time / distance. |
| `likes` | bool[] | Per-feed-post like toggle. |
| `period` | `'week'\|'month'\|'year'` | Leaderboard range. |
| `tab` | `'acts'\|'spots'\|'clubs'` | Profile tab. |

**Data fetching (production):** spots (with geo, category, difficulty, distance, ascent, rating, reviews, hours, elevation series, amenities, photos), feed posts, leaderboard/challenges, profile + badges. The prototype uses hard-coded sample arrays (`SPOTS`, `FEED`, `LB`, `BADGES`) — treat these as the data shape, not real content.

---

## Design Tokens

Authoritative source: **`styles.css`** (entry) → **`tokens/*.css`**. Consume as CSS custom properties. Values below are the ground truth (also inlined in the prototype's `:root`).

**Color — neutrals & surface**
- `--paper` `#FBF9F3` (page) · `--paper-sunk` `#F4F1E8` · `--surface` `#FFFEFB` · `--surface-2` `#F8F5EE`
- `--border` `#E8E3D8` · `--border-strong` `#D6CFC0`
- `--ink` `#1E241D` · `--ink-soft` `#3A4136` · `--text-secondary` `#3A4136` · `--text-muted` `#7C7668` · `--text-faint` `#A79F8E`

**Color — brand (Pine)** `--brand`/`--pine-600` `#216543` · `--brand-hover`/`--pine-700` `#1A5036`
Scale: `--pine-50` `#ECF4EE` · `-100` `#D6EADD` · `-200` `#AFD6BC` · `-300` `#7FBE96` · `-500` `#2E7D55` · `-600` `#216543` · `-700` `#1A5036`

**Color — accent (Clay)** `--accent`/`--clay-500` `#D5762A` · `--accent-hover`/`--clay-600` `#BC6120` · `--clay-200` `#F0C79A` · `--clay-300` `#E9A867`
> One accent moment per view. Green does the structural work; clay is the spark. Alternate accents used in the prototype's theme tweak: `#E15A4A`, `#3E8FC9`, `#6E5CC4`.

**Color — categories** (marker/chip/filter, one per activity)
- hike `#2E7D55` · run `#E15A4A` · bike `#E28C3C` · climb `#BB5A2E` · swim `#3E8FC9` · team `#6E5CC4` · calisthenics `#2E9EA0`

**Color — semantic** `--success` `#2E7D55` (bg `#ECF4EE`, border `#AFD6BC`) · `--warning` `#C9891F` (bg `#FAF0D8`, border `#EBCB84`)

**Typography**
- Sans (display/heading/UI/body): **Manrope** — weights 400/500/600/700/800. Display 800 tight tracking (-.02 to -.03em); headings 700; body/UI 400/500.
- Mono (all data & the uppercase overline/eyebrow): **JetBrains Mono** — 400/500/600/700.
- Both ship full **Cyrillic** — never introduce a face without it. Body floor 14px; mono meta floor 12px. Headings `text-wrap: balance`, paragraphs `text-wrap: pretty`.
- Observed sizes: overline 10–12px/.14em/uppercase · body 13–17px · card title 16–17px · panel title 24px · profile name 26px · onboarding display 46px · stats 15–26px.

**Radius** `--radius-md` 10px (inputs) · `--radius-lg` 14px (cards) · `--radius-xl` 20px (sheets) · pills/buttons/chips `999px` · avatars & marker dots circular.

**Elevation** (soft, bark-green-tinted — never pure black)
- `--shadow-xs` `0 1px 2px rgba(24,32,22,.06)`
- `--shadow-sm` `0 1px 2px rgba(24,32,22,.05),0 2px 6px rgba(24,32,22,.05)`
- `--shadow-md` `0 2px 4px rgba(24,32,22,.05),0 6px 16px rgba(24,32,22,.08)`
- `--shadow-lg` `0 4px 8px rgba(24,32,22,.05),0 16px 32px rgba(24,32,22,.10)`
- `--shadow-float` `0 2px 6px rgba(24,32,22,.10),0 12px 28px rgba(24,32,22,.16)` (floating map controls & sheets)

**Motion** `--dur-fast` 180ms · `--dur-base` 240ms · `--ease-out` `cubic-bezier(0.16,1,0.3,1)`. A gentle-overshoot trail ease is reserved for delight moments (marker drop, badge unlock).

**Spacing** 4px base grid (`--space-*` in `tokens/spacing.css`). Touch targets ≥ 44px. Containers: content 1120px, map-adjacent 1320px; gutter 24 desktop / 16 mobile.

---

## Assets

- **Icons:** [Lucide](https://lucide.dev) line icons — single ~1.75–2px stroke, rounded joins, `currentColor`, 24px box (16 inline / 20 button / 24 nav). In the prototype these are hand-inlined SVG paths (see the `P` map in the logic) to avoid a CDN dependency; in production use the real Lucide package. Keep one icon family and one stroke weight. **No emoji, no filled/duotone mixing.** Category meaning = icon + color + text label.
- **Imagery:** none supplied. All photo areas are neutral striped placeholders labeled in mono — **drop in real, warm, sunlit photography** of Bulgarian landscapes, trails, the Black Sea coast, and people being active. Never AI-illustrated or hand-drawn.
- **Map:** placeholder SVG surface — replace with a real map SDK (MapLibre/Mapbox GL or similar). The prototype documents marker, radius-circle, and hover-sync behavior to reproduce on it.
- **Logo:** ⚠ **none exists.** The brand currently renders as a Manrope-800 type wordmark ("Повече от просто спорт") with an optional mono "BG · OUTDOOR" overline. A real logo/mark (SVG) is still needed for the favicon, sidebar lockup, and marker pin badge — do not invent one.

---

## Files

**In this handoff bundle**
- `Platform.dc.html` — the interactive prototype (all screens + the five map interactions). Open in a browser to explore; read the source for structure, state, and behavior. Built on an in-house template runtime — **reference only, do not ship.**
- `support.js` — the prototype's runtime (lets `Platform.dc.html` open standalone). **Not for production.**
- `styles.css` — design-system entry point (imports the token files).
- `tokens/` — the token definitions: `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `radius.css`, `elevation.css`, `motion.css`, `base.css`. **This is the styling source of truth.**
- `components/` — React reference components with `.jsx`, TypeScript `.d.ts`, and `.prompt.md` per component: `actions/` (Button, IconButton), `forms/` (Input, Select, Checkbox, Radio, Switch), `data-display/` (Card, Badge, Chip, Avatar, Stat), `navigation/` (SegmentedControl), `map/` (MapMarker). Use these as the component contract.
- `guidelines/` — foundation specimen cards (type, colors, spacing, elevation, motion, brand) — visual reference for the tokens.
- `DESIGN_SYSTEM.md` — the full design-system guide (voice/copy, color, type, layout, iconography, do/don't). Read this first for the *why*; read this handoff for the *what to build*.

**Recommended reading order:** `DESIGN_SYSTEM.md` (principles) → this README (screens, interactions, state, tokens) → `Platform.dc.html` in a browser (see it move) → `Platform.dc.html` source + `components/` (implementation detail).
