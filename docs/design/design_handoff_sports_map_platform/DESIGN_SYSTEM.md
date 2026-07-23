# Повече от просто спорт — Design System

> _"More than just sport."_ The design language for Bulgaria's map-first platform for outdoor & sport activities: discover spots, log activities, compete, and build local community.

This is the single source of truth for how the product looks, feels, and reads. It is built to be handed directly to Claude Code (or any engineer) and implemented against the real web platform. Link **`styles.css`** and consume the semantic CSS custom properties — never hard-code hex values in product code.

---

## 1. Product context

**What it is.** A map-first web platform (responsive web + mobile-first PWA) where young, active people in Bulgaria discover places for outdoor & sport activities, add their own spots, log visits, join clubs, attend events, and compete on leaderboards and challenges.

**Who it's for.** Young, active, community-minded people — hikers, runners, cyclists, climbers, swimmers, ballers, and the outdoor-gym crowd. They value the outdoors, authenticity, and doing things together.

**The map is the home screen.** Everything radiates from an interactive map of Bulgaria. Content (spots, activities, leaderboards, clubs) layers on top of and beside the map.

**Activities covered (v1):** Hiking & trekking · Trail / road running · Mountain biking · Climbing & bouldering · Swimming & open water · Team sports (football, basketball…) · Calisthenics & outdoor gym.

**Core surfaces:** Map discovery · Spot detail · Add-a-spot · Search & filters · Activity feed · Competitions & leaderboards · Challenges / quests · Clubs & groups · User profile · Onboarding & login.

**Design north star.** Modern, expensive, and techy — but close to nature, eco, and active. Warm and community-driven, never corporate or cold. Think premium outdoor gear brand crossed with a precise mapping/GPS tool. Restraint over decoration; real photography over illustration; data shown with confidence.

### Sources
No existing codebase, Figma, brand assets, or logo were provided. This system was authored from scratch against the brief above. If/when the platform's real repo or brand assets exist, reconcile against them — the code is the ground truth, not this document.

---

## 2. Content fundamentals (voice & copy)

**Bilingual.** The UI is **Bulgarian + English**. Bulgarian is primary for the Bulgarian audience; English is the fallback / international layer. Every string must have both. All fonts in this system ship full **Cyrillic** — never introduce a face that lacks it.

**Voice: warm & community-driven.** We sound like a knowledgeable friend who's already been up the mountain, not a brand or an app. Encouraging, plain-spoken, a little energetic. We celebrate showing up more than winning.

- **Person.** Address the user as "ти/твой" (informal "you"), and "you/your" in English. We are "ние/we" only when it's genuinely the community.
- **Casing.** Sentence case everywhere — buttons, headings, menus, labels. No Title Case, no ALL CAPS except the mono overline/eyebrow label style.
- **Tone.** Confident and calm, warm not hype. Verbs first on actions ("Add a spot", "Добави място"; "Join the challenge", "Включи се"). Avoid exclamation-mark spam — earn it (a badge unlock can have one).
- **Numbers & data are honest and specific.** "12,4 км · 640 m ascent · 4 ч" beats "a long hike". Use metric (km, m, °C) and 24-hour time. Distances/elevation/time render in the mono face.
- **No jargon, no corporate filler.** Never "leverage", "seamless", "unlock your potential". Do say "trailhead", "elevation", "meetup", "crew".
- **Emoji:** not used in the product UI. Category and status meaning is carried by icons + color, not emoji.

**Examples**
- Empty state: "Още никой не е добавил място тук. Бъди първият." / "No spots here yet. Be the first."
- CTA: "Добави място" / "Add a spot" · "Запиши се за събитието" / "RSVP to the event"
- Leaderboard: "3-то място този месец · 8 изкачвания" / "3rd this month · 8 summits"
- Toast (success): "Мястото е добавено. Благодарим!" / "Spot added. Thank you!"
- Microcopy (difficulty): "Умерено" / "Moderate" — plain words, backed by a color chip.

---

## 3. Visual foundations

### 3.1 Color
Warm, natural, and premium. The system is **light mode only**.

- **Backgrounds** are warm paper (`--paper` `#FBF9F3`), never pure white for the page. Surfaces (cards, sheets) are a warm near-white (`--surface`). Recessed areas use `--paper-sunk`.
- **Ink** is a deep bark-green near-black (`--ink` `#1E241D`), not pure `#000` — softer, more organic, still high-contrast (passes AA on paper).
- **Brand = Pine.** Deep evergreen (`--brand` = `--pine-600` `#216543`). Used for primary actions, active nav, brand moments. A full 50–900 scale is provided.
- **Accent = Clay/Amber.** A warm summit-sunrise orange (`--accent` = `--clay-500` `#D5762A`). Reserved for energy: key CTAs on photography, "live"/activity emphasis, highlights, the earned-badge moment. Use sparingly so it stays special.
- **Category colors** form a controlled "trail-blaze" set (`--cat-hike/run/bike/climb/swim/team/calisthenics`) — mid-chroma so they read as a family, used for map markers, activity chips, and filters. Each activity always maps to the same color.
- **Semantic:** `--success` (pine), `--warning` (amber), `--danger` (rust), `--info` (glacier blue), each with a matching `-bg` and `-border`.

Rule: at most one accent moment per view. Green does the structural work; clay is the spark.

### 3.2 Typography
- **Manrope** — display, headings, and all UI/body. Modern humanist grotesque: geometric enough to feel techy, warm enough to feel human. Extrabold (800) with tight tracking for display; 700 for headings; 400/500 for body & UI. Full Cyrillic.
- **JetBrains Mono** — all data and labels: distances, elevation, time, coordinates, stats, leaderboard figures, tags, and the uppercase **overline/eyebrow** style (`--ls-overline`, 12px). This mono layer is the "techy/GPS instrument" signal. Full Cyrillic.
- Scale runs `--fs-overline` (12) → `--fs-display-2xl` (64). Headings use `text-wrap: balance`; paragraphs `text-wrap: pretty`.
- Never below **14px** for body UI; **12px** floor for mono meta labels.

### 3.3 Space, layout & grid
- 4px base grid via `--space-*`. Generous whitespace — premium comes from air, not density.
- Containers: `--container-lg` (1120) for content, `--container-xl` (1320) for map-adjacent layouts. `--gutter` 24 desktop / 16 mobile.
- **Map-first layout:** full-bleed map canvas with floating, shadowed controls (`--shadow-float`) and a docked panel/sheet for content. On mobile the content panel becomes a bottom sheet over the map.
- Touch targets ≥ 44px (`--control-md`).

### 3.4 Shape & radius
Restrained corners = premium. **Buttons, chips, and pills use `--radius-pill`** (the sporty, friendly, community warmth). **Inputs** `--radius-md` (10). **Cards & sheets** `--radius-lg`/`--radius-xl` (14/20). Avatars and marker dots are circular. Never mix many radii in one component.

### 3.5 Elevation & borders
Borders do most of the separation work — a warm hairline (`--line`). Shadows are **soft, layered, and tinted with bark-green ink** (never pure black), so they sit naturally on paper. Floating map controls and sheets get `--shadow-float`. Avoid heavy drop shadows and glows.

### 3.6 Backgrounds & texture
- Page: flat warm paper. No busy gradients.
- **Signature motif:** a very subtle map-graticule/topographic grid on map-adjacent and hero surfaces — thin `--line` rules, low opacity, decorative only. Provided as a reusable treatment in the specimen cards; keep it faint.
- **Route/GPS lines** (simple polylines) are an on-brand data graphic — pine or accent stroke, rounded caps — used on spot cards and detail heroes.
- Imagery is the star: warm, sunlit, real photography of Bulgarian landscapes, trails, the Black Sea coast, and people being active. Placeholders in this kit are neutral striped fills labeled in mono — **drop real photography in production.** Never AI-illustrated or hand-drawn imagery.

### 3.7 Interaction & motion
- **Hover:** subtle — darken fill one step (`--brand → --brand-hover`), or lift a card with a shadow step. ~120–180ms.
- **Press:** shrink to `scale(0.97)` + darken. Immediate.
- **Focus:** always visible — `--ring` (pine) or `--ring-accent` on accent controls. Never remove focus outlines.
- **Entrances:** ease-out fades/slides at `--dur-base`. **`--ease-trail`** (gentle overshoot) is reserved for delight moments only: a map marker dropping, a badge unlocking. Core UI never bounces.
- Respect `prefers-reduced-motion` (handled in `motion.css`).

---

## 4. Iconography

No icon set was provided, so this system standardizes on **[Lucide](https://lucide.dev)** — an open-source line-icon family with a consistent ~1.75px stroke, rounded joins, and outdoor/sport coverage (mountain, footprints, bike, waves, tent, map-pin, trophy, users, compass…). It matches the modern-techy-yet-warm brief and is CDN-available.

> **Substitution flag:** Lucide is a chosen default, not a supplied brand set. Swap it if you adopt another line family — keep a single stroke weight and the rounded-join style throughout.

- **Style:** line icons only (no filled/duotone mixing), 1.75px stroke, 24px default box, `currentColor`.
- **Sizes:** 16 (inline/meta), 20 (buttons, inputs), 24 (nav, standalone), 28+ (feature).
- **Map markers** use category color fills with a white glyph — see the Map component.
- **No emoji** in UI. No unicode-glyph icons. Category meaning = icon + color, always paired with a text label for accessibility.
- CDN: `https://unpkg.com/lucide@latest` (or `lucide-static` for SVGs). Cards in this kit load Lucide from CDN.

---

## 5. Logo & brand mark

**No logo was provided.** Until one exists, render the brand as a **type wordmark**: "Повече от просто спорт" set in Manrope 800, tight tracking, in `--ink` or `--brand`. A compact lockup can stack the wordmark with a mono "BG · OUTDOOR" overline. See the Brand specimen card.

> **⚠ Action needed from you:** provide a logo / mark (SVG preferred) so I can build a proper lockup, favicon, and marker pin badge. I will not invent a logo.

---

## 6. Index / manifest

**Root**
- `styles.css` — global entry (import this)
- `readme.md` — this guide
- `SKILL.md` — makes this system usable as a downloadable Claude Skill

**`tokens/`** — `fonts.css` · `colors.css` · `typography.css` · `spacing.css` · `radius.css` · `elevation.css` · `motion.css` · `base.css`

**`components/`** (React `.jsx` + `.d.ts` + `.prompt.md`, grouped)
- `actions/` — `Button`, `IconButton`
- `forms/` — `Input`, `Select`, `Checkbox`, `Radio`, `Switch`
- `data-display/` — `Card`, `Badge`, `Chip`, `Avatar`, `Stat`
- `navigation/` — `SegmentedControl`
- `map/` — `MapMarker`

**`guidelines/`** — foundation specimen cards (Type, Colors, Spacing, Elevation, Motion, Brand) shown in the Design System tab.

**`ui_kits/platform/`** — high-fidelity screen recreations of the web platform (map home, spot detail, competitions, feed, onboarding).

**`assets/`** — imagery placeholders and brand type lockup. (No logo/photography supplied yet.)

---

## 7. Do & don't (quick rules)

**Do**
- Consume semantic tokens (`--brand`, `--text-primary`, `--space-4`).
- Let the map and real photography lead; keep chrome quiet.
- Show data in mono, honest and specific, metric units.
- Keep one accent (clay) moment per view.
- Write every string in Bulgarian + English, sentence case.

**Don't**
- Hard-code hex, use pure black/white, or invent new colors.
- Use gradients-as-decoration, glows, emoji, or hand-drawn/AI imagery.
- Mix icon families or stroke weights.
- Bounce core UI or hide focus rings.
- Use Title Case or exclamation spam.
