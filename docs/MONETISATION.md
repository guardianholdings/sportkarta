# SportKarta — Monetisation Implementation Plan (v1.1, 2026-07-25)

Status: **BUILT** (2026-07-25) — M1, M2, M3a and M4 are implemented, tested and
verified live; folded into `docs/ROADMAP.md` as "Stage 8 — Sustainability"
(§9a). M3b (the map-pin badge) remains deliberately unbuilt, gated as designed
on a signed sponsor's explicit demand. Migrations `0019`–`0023`, each reviewed
against the house locking/journal rules.

The §7 decisions were NOT answered by the operator before the build. Where a
decision changes code, the code was built to the plan's own recommendation and
the switch left with the operator; where it is a sales or legal decision, it is
still open. See **§7 — status** below for the per-item record. Nothing here
commits the operator to a tier name, a price, or turning any surface on.

v1.1 (2026-07-25, operator review): the municipal-services stream (the
SocietyWorks "pro model") is DROPPED by operator decision — do not
re-propose it. Replaced by S5 — direct-sold display advertising in key
spots (built in M4), with programmatic/network fill behind an explicit
priced gate (AD-2).

Grounded in a six-track research pass (2026-07-25): four codebase audits (map
pipeline, campaign engine, page/i18n conventions, admin patterns), one
guardrails audit, and one external legal/market research pass with sources.
Legal figures below are research, not legal advice — the accountant/lawyer
items are in MANUAL STEPS.

---

## 0. Executive summary

| #   | Stream                                            | What is sold                                                                                                                                                                                                        | Legal form                                                  | Revenue potential                                                                                      | Build effort                               | Phase   |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------- |
| S1  | Partners & sponsors programme + `/partnyori` page | Tiered acknowledgment: logo, link, blurb on a public page (+ optional footer strip)                                                                                                                                 | Дарение (acknowledgment) or invoiced sponsorship — per deal | Medium — the enabler for everything else                                                               | S–M (~2 sessions)                          | M1      |
| S2  | Sponsored campaigns                               | "Кампанията се осъществява с подкрепата на X" on `/kampanii/[slug]` + prize provision                                                                                                                               | Invoiced sponsorship (deliverables defined)                 | Medium, recurring per campaign                                                                         | S (1 session)                              | M2      |
| S3  | Adopt-a-facility («Осинови игрище»)               | Per-facility digital acknowledgment: "Поддържа се от X" block on the facility page (+ optional map-pin badge later, on sponsor demand); sponsor funds documented real-world upkeep, with the municipality's consent | Invoiced sponsorship or дарение with acknowledgment         | Medium-high (scales per facility; US analogues $1k–2.5k/asset)                                         | S (M3a: 1 session; map badge M3b deferred) | M3      |
| S4  | Donations page («Подкрепи ни»)                    | Nothing — asks for support; explains donor tax relief                                                                                                                                                               | Дарение                                                     | Low but zero marginal cost                                                                             | XS (part of M1)                            | M1      |
| S5  | Display advertising in key spots                  | Direct-sold, flat-rate, labelled slots (first-party served, untracked): facility pages, city pages, weekly pages, map panel                                                                                         | Реклама (invoiced)                                          | Medium — one direct-sold slot beats Bulgarian network RPMs by orders of magnitude; scales with traffic | S (1 session)                              | M4      |
| S6  | Grants                                            | —                                                                                                                                                                                                                   | Грант                                                       | Erasmus+ Sport small partnerships are lump-sum €30k/€60k; ММС + corporate grants                       | None (reports engine is the evidence base) | ongoing |

**Explicitly rejected** (see §5): behaviourally-targeted/personalised ads
and tracking pixels (never, under any setting), betting/gambling
advertisers, paid API tiers that gate data, selling the open dataset,
sponsor content in the embeddable widget, a points-redemption shop, sponsor
editing rights over facility data, merchandise, paid event/tournament
entry, premium member features. Third-party network fill is gated, not
rejected (AD-2, §S5). Municipal service contracts: dropped by operator
decision (v1.1).

---

## 1. Constraints that shape every option

### 1.1 What the architecture already decided

The repo's guardrails do not forbid sponsorship; they force it into a shape:
**content, not surveillance; declared, not implicit; beside attribution,
never instead of it.** Concretely:

- **No third-party scripts, pixels, or tracking.** The platform is cookieless
  (self-hosted Umami, no consent banner anywhere) and the privacy page
  _promises_ "не проследяваме потребителите". Any ad network, remarketing
  pixel, or sponsor-hosted creative with tracking parameters would require a
  consent banner (EDPB Guidelines 2/2023 scope) and break a published promise.
  All sponsor creatives must be **self-hosted** (storage adapter), sponsor
  links plain (no click IDs). Impression counts, if ever wanted, are
  self-hosted Umami events — nothing else. This is why S5 advertising is
  direct-sold and first-party served: the slot model needs none of the
  consent machinery, and the only sanctioned path to network fill is the
  AD-2 gate (§S5), which prices in the consent banner and the privacy-page
  rewrite it would force.
- **Open data catalogue is an allowlist** (`lib/src/opendata/schema.ts`):
  a `partners` or `facility_sponsorships` table is invisible to exports
  unless deliberately declared — the `businesses` table (migration 0018) is
  the explicit precedent for a commercial-actor table kept OFF
  `ALLOWED_RELATIONS`. Default for all sponsor tables: not exported.
- **The embeddable widget cannot carry sponsor content** — CSP
  `default-src 'none'; script-src 'none'; img-src data:`, no cookies, no
  telemetry, asserted by e2e. A static text line is the theoretical ceiling;
  the plan leaves the widget untouched.
- **ODbL attribution is untouchable.** Sponsor branding sits beside, never
  replaces, attribution. Two separate constants exist: the map basemap
  string (`ATTRIBUTION` in `apps/web/lib/map/style.ts:11`, surfaced by
  MapLibre's attribution control — currently asserted by no e2e) and the
  open-data export string (asserted by `apps/web/e2e/opendata.spec.ts:31,56`).
  M3 puts sponsor visuals on the map surface, so M3 adds the missing e2e
  assertion that map attribution renders, rather than assuming one exists.
- **Children are protected by what the platform CANNOT do, not by an age
  predicate.** Amended 2026-07-25: migration `0020_minors_as_adults` withdrew
  the minors exclusion (operator decision — minors are treated as adults), so
  "never minors" is no longer one of the guarantees. Every guarantee that
  actually constrains a sponsor is unchanged and none of them depended on it:
  no profiling ads (DSA Art 28(2) as a design floor even though the Art 19 SME
  exemption applies); no age-segmented sponsor audiences — impossible by
  construction, since a slot is selected by SURFACE and the ad layer receives
  no viewer attribute at all; no sponsor access to participant identities,
  because campaign public boards join `leaderboard_eligible_members` (now a
  pure consent record) and admin standings are `requireRole('admin')` and exist
  so _the operator_ can hand over a prize. A sponsor never receives a
  participant list. What DID change is that a member under 18 who opts in can
  appear on a public board — which is a consent question, not a sponsor
  question, and the creative rules below (no direct exhortation to children,
  UCPD Annex I pt 28; no gambling, alcohol, tobacco or energy drinks) are what
  carry the child-safety weight on the advertising side.
- **Points are earn-only** (`lib/src/points.ts`). No sponsor-redeemable
  rewards shop — it would break the ledger model and is out of scope.
- **API keys raise rate limits and never gate access** (CLAUDE.md, Stage
  6.1), and there is deliberately no request log to bill against. A "paid
  API tier" is unbuildable by design (and the data-services stream was
  dropped by operator decision — §5).
- **Sponsorship never touches facility rows.** Adopt-a-facility is an
  _adjacent_ table, not fields on `facilities` — so the merge policy,
  `facility_edits` provenance, and crowd-data protections are never in the
  blast radius, and a sponsor acquires zero authority over facility data or
  moderation (no per-facility authority concept exists; keep it that way).
- **i18n discipline**: all sponsor-facing UI copy in
  `apps/web/messages/bg.json` + mirrored `en.json` (nested keys,
  parity-tested); sponsor names/blurbs are
  DATA in bilingual columns (`name_bg`/`name_en` — the campaigns
  `title_bg`/`title_en` pattern), never message-file entries. The
  hardcoded-Cyrillic gate stays green with an empty allowlist.
- **Design-token gate**: sponsor brand colours cannot skin components
  (`no-hardcoded-design-values.test.ts`); sponsor identity is a logo image,
  not a theme.

### 1.2 What Bulgarian law decides (research 2026-07-25; verify with accountant)

- **ЗЮЛНЦ**: a сдружение may run допълнителна стопанска дейност if it is
  related to the mission, **listed in the устав**, and profit is never
  distributed. Selling sponsorship/advertising placements and municipal
  services is legal without a separate company — IF the устав names the
  activity. → MANUAL STEPS.
- **The дарение / спонсорство / реклама boundary is the tax design of every
  deal.** No counter-performance → дарение: no invoice, no CIT, no VAT, and
  (if SportKarta is registered в обществена полза) tax-deductible for the
  donor (companies: up to 10% of accounting profit, ЗКПО чл. 31; individuals
  5%, ЗДДФЛ чл. 22). Defined deliverables ("logo on X for Y months") →
  advertising service: invoice, 10% CIT on the profit, counts toward VAT
  registration. **Every package in §2 is designed as clearly one or the
  other; vague mixtures are where НАП reclassification risk lives.**
- **VAT headroom is large but cross-stream**: mandatory registration from
  €51,130 _invoiced_ taxable turnover per calendar year (2026 rule, tracked
  daily). Donations and grants don't count — but the threshold counts ALL
  invoiced streams combined (S1 + S2 + S3 + S5 ad slots); a headline
  sponsor plus several sold slots adds up. The revenue register (§Ongoing)
  tracks the combined total.
- **Prizes** (relevant to S2): free-entry, effort-based campaigns are outside
  Закона за хазарта (no stake). Prize tax: non-cash random-draw prizes ≤100
  лв (≈€51 — post-euro figure to verify) are exempt; otherwise the
  _organiser_ withholds 10% окончателен данък (ЗДДФЛ чл. 38, ал. 14) and
  files декларация по чл. 55 — and for skill-based standings the exemption
  likely does not apply at all, so assume withholding from the first lev
  until the accountant confirms. Prefer non-cash prizes; never cash.
- **Closed sponsor categories**: gambling/betting operators (May 2024 ЗХ
  amendments ban gambling advertising on websites; fines 5,000–50,000 лв —
  and minors use the platform). Sponsor creatives must never contain a
  direct exhortation to children to buy (UCPD Annex I pt 28 via ЗЗП).
- **Обществена полза status** (if registered) is a selling point: donor-side
  tax relief only works for public-benefit recipients, verifiable in the
  Registry Agency's НПО register.

---

## 2. The streams in detail

### S1 — Partners & sponsors programme (the enabler)

What is sold, in tiers (names/prices are anchors for the operator to set;
no published Bulgarian rate-card data exists — tiers designed from parkrun's
headline+category structure and corporate-grant sizes):

| Tier                                               | Suggested anchor         | Deliverable                                                                                                      |
| -------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Генерален партньор (headline, max 1–2)             | €5,000–15,000/yr         | Logo+blurb top of `/partnyori`, optional strip on the allowlisted surfaces (M1), named in press/report materials |
| Партньор (category, e.g. "движение", "оборудване") | €1,500–5,000/yr          | Logo+link on `/partnyori`, eligibility to sponsor campaigns (S2)                                                 |
| Поддръжник (supporter)                             | €500–1,500/yr or in-kind | Name listing on `/partnyori`                                                                                     |
| Институционален партньор                           | non-commercial           | Municipalities, ММС, federations — listed separately, never invoiced                                             |

Pitch targets from the market research: Decathlon (runs an open partnership
programme, mission-aligned), Lidl/Kaufland CSR, banks (DSK, Postbank),
telecoms (Vivacom — also its Регионален грант, A1), insurers (facility
naming precedent: "Парк Арена ОЗК" Burgas). Companies are Bulgaria's largest
donor class (66.3 млн лв in 2023, ~48% of registered giving).

**Sponsor acceptance policy** (write it down before the first deal):

- Exclusion list beyond the legally-forced gambling ban: alcohol, tobacco/
  vaping, energy drinks, political parties, religious organisations —
  operator/board to confirm the exact list; the platform serves children.
- Headline tier requires board sign-off; other tiers the operator decides.
- Declared-conflict rule: a sponsor that is also a commercial actor in the
  `businesses` table (a paid-venue operator) may not adopt the free facility
  nearest its own venue, and the overlap is declared in the deal notes.
- Every contract carries a reputational termination clause (scandal,
  ownership change into an excluded category → acknowledgment comes down,
  pro-rata refund terms defined up front).
- Announce the programme to the contributor community BEFORE the first
  logo appears — crowd contributors verified those facilities; they hear it
  from us, not from a badge.

### S2 — Sponsored campaigns

The campaign engine (Stage 5.3) is the natural vehicle and is already
structurally safe for it: scoring counts everyone, display is gated, prizes
are free-text columns, closing freezes standings. A sponsor buys the
campaign's branding line and provides the prize. What they can never buy:
novel scoring (the rules grammar is closed — a new scoring kind is a deploy),
participant identities, or minor-targeted mechanics.

The sponsorship contract must name **who legally awards the prize** — that
party carries the 10% withholding + чл. 55 declaration duty (§1.2). If the
sponsor hands the prize over directly, the admin burden moves to them; say
so in the pitch, it is a feature.

### S3 — Adopt-a-facility («Осинови игрище»)

A company funds the upkeep/renovation of a specific mapped facility
(offline: equipment, paint, nets — the real-world value) and receives a
digital acknowledgment: a "Поддържа се от X" block on `/obekt/[slug]` and a
listing on `/partnyori` (map-pin badge deferred to M3b — see below).
US municipal analogues price physical-asset adoption at $1,000–2,500;
suggested anchor €500–2,500/yr per facility by size and city. This is the
stream with the most natural PR story (a before/after renovated playground)
and it directly funds the map's own subject matter.

**It is a three-party deal, not two.** Most facilities are municipal
property: a sponsor funding upkeep of public land needs the owner's consent
(installation permits, liability), so every adoption is backed by a
municipal consent/partnership memo (template → MANUAL STEPS). And the
acknowledgment follows **documented work**: "Поддържа се от X" is a factual
claim on a platform whose brand is verifiable data, so the badge goes live
after the funded upkeep is evidenced — the platform's own condition-report
flow is the natural evidence trail, and "your renovation is verified by the
same crowd machinery as everything else" is a pitch line, not overhead.

Deliberate limits: logos render on the facility page and `/partnyori` only;
the eventual map badge (M3b) is a _marker variant_, never a logo pin — the
map stays a public-infrastructure map, not an ad surface. Sponsorship is
time-bounded (annual) and lapses visibly.

### S4 — Donations page

A static `/podkrepi` page: IBAN (bank transfer), what donations fund, the
donor tax-relief explanation (ЗКПО/ЗДДФЛ limits, публичен register link),
and a contact for дарение contracts. No on-site payment processing — a
payment provider's script would be the first third-party script on the site;
if card donations are wanted later, link OUT to a hosted payment page
(processor-hosted, their cookies on their domain) rather than embedding.

### S5 — Display advertising in key spots (direct-sold, first-party served)

"Classic advertising" on this platform means what it meant in print: a
fixed, labelled slot in a prominent place, sold directly to an advertiser
at a flat rate per period. That model needs **no consent machinery**: the
site serves the creative itself, selects it by page context only (slot =
surface, never viewer), stores nothing on the device — first-party,
untracked, contextual content does not engage ePrivacy Art 5(3) at all
(§1.2 research), so the no-banner posture and the privacy promise survive
intact.

The slots (each is a deliberate placement decision; every surface not
listed stays ad-free):

| Slot key        | Surface                                     | Note                                                                            |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `facility_page` | `/obekt/[slug]`, below the detail card      | the highest-volume SEO surface                                                  |
| `city_page`     | `/igrishta/[city]`, after the facility list | ISR 3600 — a creative change appears within the hour                            |
| `weekly_page`   | `/sedmitsata/[city]`                        | contextual fit: local, activity-minded audience                                 |
| `map_panel`     | a card inside the map explorer's list panel | the map CANVAS stays ad-free forever — the panel sits beside the map, not on it |

Excluded surfaces, permanently: passport pages, `/obshtina` accountability
pages, `/danni`, the embed widget, auth/admin, and all e-mail. One
advertiser per slot per period (exclusivity is simpler to build and easier
to sell); an unsold slot collapses to nothing — no house-ad placeholder.

Pricing is flat-rate monthly per slot, anchored to real traffic (the media
kit's Umami figures); the deliverable report is page views, never per-user
metrics. The sponsor acceptance policy (§S1) applies to advertisers
identically, plus the creative rules: mandatory «Реклама» label, no direct
exhortations to children (UCPD), creative self-hosted through the same
image pipeline, `rel="sponsored noopener"` on the link.

**AD-2 — the network-fill gate (default OFF).** If the operator ever wants
programmatic fill (AdSense-class), _that_ is the architecture change, and
it is priced here so the decision is made once, eyes open: a consent
banner/CMP (the first consent machinery on the site), a rewrite of the
privacy-page promise ("не проследяваме потребителите" cannot stay as
written), third-party scripts on ad surfaces, and non-personalised-only
configuration (minors use the platform; behavioural targeting stays
forbidden under every setting). Revenue reality: Bulgarian display RPMs run
roughly €0.5–2, so meaningful network revenue needs traffic the platform
does not yet have — one direct-sold slot at €300/mo out-earns
150k–600k network impressions. Recommendation: ship the direct-sold model,
revisit AD-2 only if traffic grows by an order of magnitude — and record
the decision here when it is made.

### S6 — Grants (context, not code)

Erasmus+ Sport Small-scale Partnerships (€30,000/€60,000 lump sums, designed
for grassroots newcomers); ММС "Спорт за всички" calls (eligibility usually
requires ЗФВС чл. 9 registration — check per call); Vivacom Регионален грант
and similar corporate programmes. The quarterly report generator and
`/statistika` reconciliation are the credibility asset here — every figure a
grant application cites is SQL-traceable.

---

## 3. Implementation phases

Each phase is a small number of plan-first sessions (estimates below are
honest, not aspirational) with one forward-only migration, reviewed by
db-migration-reviewer, following the house patterns below. M2, M3 and M4
depend on M1's registry; everything is independent of the still-open
Stage 4.3. (Migration numbers 0019–0022 were free as of 2026-07-25 —
re-check at build time; if M1 and M4 are built in the same session their
migrations can merge into one.)

### M1 — Partners registry, `/partnyori`, `/podkrepi` (migration `0019_partners`; ~2 sessions)

> **STATUS 2026-07-25: largely BUILT.** Shipped: migration `0019_partners`
> (db-migration-reviewer's blocking snapshot finding + suggestions applied),
> `apps/web/lib/partners.ts`, admin CRUD at `/admin/partnyori` (list with
> изтича-скоро indicator, create/edit with logo upload through the
> EXIF-strip pipeline), the row-decides logo route `/api/partners/logo/[id]`
> (visible partners only), and the public `/partnyori` page (tier sections
> with "how we partner" intros, `rel="sponsored noopener"` links, become-a-
> partner CTA, transparency disclosure; footer link + sitemap + crawler
> seeds). Verified live end-to-end with a sample partner in the dev DB.
> **CLOSED 2026-07-25.** `/podkrepi` shipped: env-driven bank details
> (`DONATION_IBAN`/`DONATION_BENEFICIARY`/`DONATION_BIC`/`DONATION_REFERENCE`,
> all documented in `.env.example`), fail-closed to "write to us" when absent or
> malformed (`apps/web/lib/donations.ts` + 10 unit tests; the warning never
> carries the value), the tax-relief section as information with an
> "ask your accountant" line, footer link, sitemap entry and crawler seed. The
> headline strip shipped BEHIND `PARTNER_STRIP_ENABLED` (default off) with the
> surface allowlist enforced by import site rather than by a layout.

**Schema** — `partners` table, modeled on `businesses` (0018) + the
campaigns content-column pattern:

```
partners (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         text NOT NULL UNIQUE,          -- campaigns_slug_shape-style CHECK
  tier         text NOT NULL,                 -- CHECK IN ('headline','category','supporter','institutional')
  name_bg      text NOT NULL, name_en text,   -- ≤120 CHECKs, btrim <> ''
  blurb_bg     text, blurb_en text,           -- ≤2000 CHECKs
  url          text,                          -- CHECK ~ '^https?://' AND ≤300
  logo_path    text,                          -- facility_photos_storage_path_sane-style CHECK
  visible      boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  starts_on    date, ends_on date,            -- optional window; CHECK ends_on >= starts_on
  created_at / updated_at timestamptz
)
```

Deliberately **NOT** added to open-data `ALLOWED_RELATIONS` (the 0018
`businesses` posture; the allowlist test makes silent leakage impossible).
Migration header documents this decision + rollback note, house style.
Equally deliberate: **no contact-person columns.** Sponsor contacts are
natural persons; they live in the offline CRM spreadsheet under the NGO's
records of processing, never in the platform database.

**Admin** — `/admin/partnyori` (`requireRole('admin')` on page and every
action; nav row in the `(protected)/layout.tsx` items array + `AdminNav`
key): copy the `chastni` (simplest) + `kampanii` (form/actions) patterns —
`page.tsx` list, `actions.ts` with pure `buildPartnerInput()` throwing typed
error codes, `partner-form.tsx` client form via `useActionState`,
`revalidatePath` after mutations; the partner list shows an "изтича скоро"
indicator for windows ending within 60 days (a sorted list is enough — no
job needed), so a headline logo never silently vanishes mid-renewal. Logo
upload reuses `processReportPhoto` (8 MB cap, EXIF stripped, webp) via a
`storeContributionPhoto`-style helper with prefix `'partners'` (no slash —
the key builder adds separators); on tx failure `discardContributionPhoto`.
NB: `processReportPhoto` accepts jpeg/png/webp only — sponsor logos usually
arrive as SVG, which stays unaccepted deliberately (SVG is an XSS vector);
ask sponsors for PNG, rasterize on our side if needed.
**Serving**: a `GET /api/partners/logo/[id]` route that looks the storage
key up FROM THE ROW and streams `getStorage().get(key)` (the opendata-dumps
"row decides, not the path" pattern) — do NOT depend on the `/uploads/*`
prefix: nothing serves it (`deploy/Caddyfile` proxies everything but
`/tiles/*` to Next, which has no `/uploads` route or `public/uploads` dir),
and separately the `/data/uploads` volume has an open root-ownership/EACCES
write issue tracked in `docs/launch/checklist.md:163`.

**Public** — `apps/web/app/[locale]/partnyori/page.tsx`: server component,
`AppShell`, `max-w-3xl`, per-tier sections rendering `visible AND (window
active OR window null)` partners as `/danni`-style article cards; every
partner URL renders with `rel="sponsored noopener"` (selling followed links
is a search-engine link-scheme violation, and the collateral damage would
land on the `/igrishta` SEO pages — the attribute is inherited by every
sponsor link M2/M3 add); logo `<img>` alt text is `name_bg`/`name_en`; new
`Partners` namespace in `apps/web/messages/bg.json` + `en.json`; footer link
in `site-footer.tsx` (`Footer.partners`); sitemap entry in the `static.xml`
case of `app/sitemaps/[name]/route.ts`; indexable (no robots override),
`buildAlternates('/partnyori', locale)`. (Route transliteration: `partnyori`
everywhere — public page and admin section match, like `kampanii`.)

`/podkrepi`: static prose page (privacy-page recipe), `Podkrepi` namespace,
footer link optional; content per §S4. Bank details injected via env
(`DONATION_IBAN` etc.) — never hardcoded, documented in `.env.example`.

**Crawler coverage**: add `/partnyori` and `/podkrepi` to `PUBLIC_ROUTES`
and `/admin/partnyori` to `ADMIN_ONLY` in `apps/web/e2e/crawl.spec.ts` —
footer-linked pages get discovered and status-checked automatically, but
only seed routes get the full landing-surface checks, and `/podkrepi` gets
nothing at all if its footer link is skipped.

**Optional in M1** (operator decision, §7): a "с подкрепата на" strip
showing headline-tier logos — on an **allowlist of surfaces only** (home
`/kampanii`, `/igrishta` city pages), never site-wide. Explicitly excluded:
passport pages (a corporate logo on a page about a possibly-minor member),
`/obshtina` accountability pages (a sponsor logo under the metrics that
hold mayors accountable is untenable),
`/danni`, and the map page (which composes its own shell and stays clean).

**Tests**: i18n parity picks the new namespaces up automatically; e2e crawl
covers the new footer-linked pages automatically; add a unit test on the
partner-input builder and a route test asserting the logo route 404s for
unknown ids and never reflects user input into storage keys.

### M2 — Sponsored campaigns (migration `0022_campaign_partner`)

> **STATUS 2026-07-25: BUILT.** One nullable FK + partial index; wired through
> `db/schema`, `CAMPAIGN_COLUMNS`/`toCampaign`/`CampaignRow`, the web
> `CampaignInput`/builder/create/update, a tier-filtered `<select>` in
> `campaign-form.tsx`, and a shared `<CampaignSponsor>` block on both public
> prize-card sites. Verified live: the sponsor line renders with logo and
> `rel="sponsored noopener"`, and hiding the partner withdraws it. (Migration
> number is 0022, not 0020 — 0020 was taken by `minors_as_adults` and 0021 by
> the ad slots, which were built first per §4's sequencing.)

**Schema**: `campaigns.partner_id` bigint nullable
`REFERENCES partners(id) ON DELETE RESTRICT` + partial index (every FK gets
an index — reviewer rule). Reuses the M1 registry (one partner, many
placements) rather than duplicating name/logo columns per campaign.

**Wiring** (the exact chain the campaigns audit mapped): `db/schema/index.ts`
column; `CAMPAIGN_COLUMNS` + `toCampaign()` + `CampaignRow` in
`db/src/campaigns.ts`; `CampaignInput`/`buildCampaignInput`/`createCampaign`/
`updateCampaign` in `apps/web/lib/campaigns.ts`; a partner `<select>` in
`campaign-form.tsx` (the form uses raw `<select>` elements, not the
`ui/select.tsx` component — match the file; server page passes the partner
list as props, **filtered to `tier IN ('headline','category')`** — that is
what the §S1 tier table sells, and an institutional partner on a sponsored
campaign would contradict "never invoiced");
sponsor block on the two public prize-card sites
(`kampanii/[slug]/page.tsx` ~103–108 and `[slug]/rezultati/page.tsx` ~80–85)
rendering partner name + logo + link with an i18n "Кампанията се осъществява
с подкрепата на" label; optional "с подкрепата на X" line on the `/kampanii`
list card.

**Rules stated in code comments**: the sponsor block is content; sponsor
identity never enters `campaign_results` (which stores no display data at
all — the 0012 design); admin standings remain the only place names appear
and only for prize handover.

### M3 — Adopt-a-facility (migration `0023_facility_sponsorships`)

> **STATUS 2026-07-25: M3a BUILT, M3b DELIBERATELY NOT.** M3a shipped with the
> exclusion constraint (btree_gist, `'[]'` inclusive), the
> `apps/web/lib/facility-sponsors.ts` read embedding `PARTNER_RENDERABLE`, a
> "Поддържа се от" SectionCard on `/obekt/[slug]` (the lower-risk option — the
> `FacilityDetail` shape was left untouched so sponsor fields cannot leak into
> the provenance line or the JSON-LD), and admin management on the partner's
> screen. 11 live-DB tests including "the facility open-data export is
> byte-identical before and after an adoption". M3b stays gated on a signed
> sponsor's explicit demand, as designed.

Split deliberately: **M3a** (the sellable unit — table, admin, facility-page
block; ~1 session) ships first; **M3b** (the map-pin badge) is built only if
a real sponsor makes it a deal condition. The badge is the most
reputationally loaded surface in the plan (the one place the map itself
stops being purely public infrastructure), it is the bulk of the build (the
9-touch-point chain below), and it is the deliverable sponsors care about
least — the PR story lives in the facility-page block, the before/after
photos, and `/partnyori`.

**Schema (M3a)**:

```
facility_sponsorships (
  id           bigint identity PK,
  facility_id  uuid NOT NULL REFERENCES facilities(id) ON DELETE RESTRICT,
  partner_id   bigint NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  label_bg     text, label_en text,        -- optional plaque line, ≤200
  starts_on    date NOT NULL, ends_on date NOT NULL,   -- always bounded (annual)
  created_at   timestamptz,
  -- one active sponsorship per facility at a time:
  EXCLUDE USING gist (facility_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
)
```

(the exclusion constraint needs `btree_gist`, which is **not currently
enabled** — `0000_init-postgis-health.sql:3` creates only `postgis` — so
`0021` opens with `CREATE EXTENSION IF NOT EXISTS btree_gist;`; the prod
image `postgis/postgis:16-3.4` ships it, and PG 16's btree_gist supports
uuid. If the reviewer prefers to avoid the first post-init extension, the
fallback is a partial unique index + application check). Off open-data
`ALLOWED_RELATIONS`, same as `partners`. **No column on `facilities`** — no
merge-policy interaction, no `facility_edits` requirement, no sponsor
authority anywhere.

**Rendering rule (both M3a and M3b)**: a sponsorship renders only where
`partner.visible` AND the partner window is active AND the sponsorship
window is active — one join condition, stated once. Without it, a lapsed or
hidden partner could still show on a facility page that `/partnyori` denies
exists.

**Facility page (M3a)**: "Поддържа се от" block — either a row inside
`FacilityDetailView` next to the provenance line or (lower risk) a new
`SectionCard` in `obekt/[slug]/page.tsx`; logo via the M1 logo route (alt
text, `rel="sponsored noopener"`); extend `getFacilityBySlug` with the
active-sponsorship join.

**Admin (M3a)**: manage on the partner's detail screen in `/admin/partnyori`
(facility picker + window), reusing the M1 CRUD patterns.

**Map pin badge (M3b, deferred)** — the 9-touch-point chain the map audit
mapped: add a scalar `sponsored: boolean` (or partner-slug string) property
in `apps/web/lib/public-data.ts` GeoJSON SELECT (LEFT JOIN on the rendering
rule above) → `MapPoint`/`toFeatureCollection`/`syncMarkers`/
`createPin` in `map-canvas.tsx` + `markers.ts` (the POPS pin — the badge
element would sit beside the `pinSvg()` wrapper spans) → a `.sk-marker__badge`
element styled in `globals.css` (tokens only, no hex in TS). Thread through
`map-explorer.tsx` (fetch mapping + optional chip in `FacilityPreview`) and
`place-map.tsx`/`places.ts` for the `/igrishta` pages (NB: `places.ts` has
its own inline predicate — thread explicitly, nothing propagates for free).
Cluster signalling via `clusterProperties` is optional polish, default no.
M3b also adds the missing map-attribution e2e assertion (§1.1).

**Tests**: active-window + rendering-rule logic (Sofia civil dates,
`ends_on` inclusive — follow the campaigns window convention), the exclusion
constraint under overlap, and an assertion that the facility open-data
export is byte-identical before/after a sponsorship row exists (the
allowlist makes this structural, the test makes it visible). M3b adds
GeoJSON property presence/absence.

### M4 — Ad slots (migration `0021_ad_placements`; ~1 session)

> **STATUS 2026-07-25: BUILT.** `partners.tier` gained `'advertiser'`;
> `ad_placements` with `EXCLUDE USING gist (slot, daterange) WHERE (visible)` —
> the partial predicate is deliberate, so drafts may overlap while two LIVE
> placements cannot. `<AdSlot>` is a server component with no client JS, no
> external request and no viewer input; `<AdCreative>` is hook-free markup so
> the `map_panel` slot can be rendered by the client map explorer from
> server-resolved props. Creatives stream from a row-decides route that repeats
> the visibility predicate (a draft creative 404s even to a guessed id) and
> counts nothing. 13 live-DB tests on exclusivity + 11 unit tests, including
> "the read selects nothing about the viewer". Verified live on
> `/igrishta/sofia`: «РЕКЛАМА» label, `rel="sponsored noopener"`, and the ad
> disappearing the moment the advertiser is hidden.

**Schema**: the `partners.tier` CHECK gains `'advertiser'` (an advertiser
lives in the same registry — same logo/creative pipeline, same acceptance
policy, same no-contact-columns rule), plus:

```
ad_placements (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner_id    bigint NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  slot          text NOT NULL,  -- CHECK IN ('facility_page','city_page','weekly_page','map_panel')
  creative_path text NOT NULL,  -- facility_photos_storage_path_sane-style CHECK
  url           text NOT NULL,  -- CHECK ~ '^https?://' AND ≤300
  alt_bg        text NOT NULL, alt_en text,   -- ≤200 CHECKs
  starts_on     date NOT NULL, ends_on date NOT NULL,
  visible       boolean NOT NULL DEFAULT false,
  created_at    timestamptz,
  -- one advertiser per slot at a time:
  EXCLUDE USING gist (slot WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
)
```

(same `btree_gist` note as M3 — whichever migration lands first runs
`CREATE EXTENSION IF NOT EXISTS btree_gist;`). Off open-data
`ALLOWED_RELATIONS`, like every table in this plan.

**Rendering**: one server component, `<AdSlot slot="…">`: queries the
active placement (`visible` AND `partner.visible` AND both windows active —
the M3 rendering rule), renders the self-hosted creative + link
(`rel="sponsored noopener"`, alt text) under a mandatory «Реклама» label
(i18n key, both catalogues), or renders NOTHING when the slot is unsold.
No client JS, no cookies, no external request — this component is what
makes "no consent banner needed" true, and a code comment says exactly
that. The `map_panel` slot passes its placement as props from the server
page into the map explorer (client component — the `@sportkarta/lib`
barrel stays out per the client-imports rule).

**Admin**: placements managed on the partner's screen in `/admin/partnyori`
(slot picker + creative upload + window), M1 CRUD patterns; the "изтича
скоро" indicator covers ad windows too.

**Serving creatives**: the same DB-row-decides streaming route as M1 logos
— one route, key always from the row, never from the path.

**Tests**: slot exclusivity under overlapping windows; an unsold slot
renders nothing; the «Реклама» label is present whenever a creative
renders; i18n parity; the open-data export unchanged by placements
(structural via the allowlist, made visible by the test).

### Ongoing — sales & finance ops (no code; budget real hours)

Rate-card document; two contract templates (договор за дарение with
acknowledgment wording vs спонсорски/рекламен договор with deliverables);
invoice sequence; a simple revenue register (spreadsheet is fine) tracking
the **combined** invoiced total across all streams against the VAT threshold
(daily-tracked calendar-year rule); annual CIT filing for the стопанска
дейност profit; a one-page **media kit** (audience + impact figures from
`/statistika` and aggregate Umami traffic — the SQL-traceable figures are
the pitch asset); a defined **deliverable report** for renewals (screenshots

- page views; explicitly no per-sponsor click tracking — that keeps every
  deal inside the no-tracking posture); **annual funder disclosure** — names
  always, amounts by tier band — on `/partnyori` and in the NGO's annual
  report (the ЗЮЛНЦ public-benefit annual filing will surface the revenue
  anyway; choosing the narrative beats being read from a registry).

**Honest ops estimate**: sales conversations, contract admin, invoicing,
tax filings, renewal chasing and deliverable reports are ~8–15 h/month once
2–3 deals exist — against a 15–20 h/week total budget that also builds the
product. ROADMAP §10 already names ops-not-code as risk #1; monetisation
makes it heavier, which is an argument for fewer, larger deals over many
small ones.

---

## 4. Sequencing recommendation

1. **M1 first** — it unlocks every sales conversation ("here is the page
   your logo will be on"), and S4 rides along for free.
2. **M4 immediately after, or bundled with M1** — the registry and the ad
   slots sell together ("here is the page AND the slot"), and the ad slot
   is the easiest first invoice.
3. **M2 next campaign cycle** — the schema delta is one FK; sell the first
   sponsored campaign before building more.
4. **M3a when the first adopter is warm** — do not build it speculatively
   before a pilot sponsor conversation exists; **M3b (map badge) only on a
   signed sponsor's explicit demand**.
5. **S6 grants in parallel as ops work** — no code is blocking it.

The open Stage 4.3 (organizer tools) and the audit follow-through items are
unaffected; monetisation phases slot between them as operator priority
dictates.

---

## 5. What we will NOT do (and why, for the record)

| Rejected                                                                | Reason                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behaviourally-targeted / personalised ads, remarketing, tracking pixels | Never, under any setting — minors + GDPR + the privacy promise. Not even under AD-2.                                                                                                                                   |
| Third-party network fill (contextual)                                   | Not rejected outright — gated behind AD-2 (§S5), which prices the consent banner, third-party scripts, and privacy-page rewrite it forces. Default OFF; BG network RPMs make it a bad trade at current traffic anyway. |
| Municipal service contracts (the "pro model")                           | Dropped by operator decision 2026-07-25 — do not re-propose.                                                                                                                                                           |
| Betting/gambling sponsors or advertisers                                | ЗХ 2024 ad ban on websites; minors on the platform. Categorically closed.                                                                                                                                              |
| Paid API tiers gating data                                              | Keys may only raise rate limits (Stage 6.1 design); no request log exists to bill against; data is ODbL-open regardless.                                                                                               |
| Selling the dataset / exclusive data deals                              | ODbL — anyone may take the same export; exclusivity is unsellable and contrary to mission.                                                                                                                             |
| Sponsor content in the embed widget                                     | CSP `script-src 'none'`, no external requests — structurally excluded, deliberately kept so.                                                                                                                           |
| Points shop / redeemable rewards                                        | Ledger is earn-only by design; changing that reopens the anti-abuse surface for no proven revenue.                                                                                                                     |
| Sponsor moderation/edit rights or "curated" facilities                  | No per-facility authority concept exists; provenance and crowd-protection rules stay sponsor-free.                                                                                                                     |
| Cash prizes                                                             | Always taxable, worst optics, no upside over non-cash.                                                                                                                                                                 |
| Merchandise                                                             | Inventory, VAT on goods, fulfillment — the worst effort-to-revenue ratio available to a one-operator NGO.                                                                                                              |
| Paid event/tournament entry                                             | An entry fee is a _stake_ — it demolishes the plan's own "free-entry campaigns are outside Закона за хазарта" analysis, besides contradicting the mission.                                                             |
| Premium member features                                                 | Points are earn-only, users include minors, and the mission is free access; a paywall inside the product is unsellable and wrong.                                                                                      |

---

## 6. Risk register

| Risk                                                                       | Likelihood | Mitigation                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reputational: "the NGO map is going corporate"                             | Medium     | Sponsor acceptance policy (§S1); no map badge in v1 (M3b deferred); strip surfaces allowlisted; funder disclosure (§Ongoing); the map itself stays logo-free forever.                                   |
| Community: crowd contributors resent brands on facilities they verified    | Medium     | Announce before the first logo (§S1); acknowledgment follows documented upkeep (§S3) so a badge means real value delivered to _their_ facility.                                                         |
| Ad clutter dilutes the public-infrastructure identity                      | Medium     | Four slots only, on allowlisted surfaces; one advertiser per slot; the map canvas is ad-free forever; unsold slots collapse to nothing; adding a slot requires editing this doc's table, not just code. |
| Regulatory: НАП reclassifies a vague deal; VAT threshold crossed unnoticed | Low-medium | Every package pre-typed as дарение OR invoiced service (§1.2); combined-stream revenue register; accountant on retainer for the first deals.                                                            |
| Operator bandwidth: sales+admin crowd out the product                      | High       | Honest hours line (§Ongoing); fewer/larger deals; M3b exists only behind a signed sponsor's demand.                                                                                                     |
| Sponsor becomes embarrassing mid-term                                      | Low        | Reputational termination clause in every contract (§S1).                                                                                                                                                |

---

## 7 — status (2026-07-25, after the build)

| #   | Decision                                     | Status                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tier names / price anchors                   | **OPEN — sales, no code.** The four tiers plus `advertiser` exist as data; renaming a tier is two i18n keys, repricing is a rate-card document.                                                                                                                              |
| 2   | Headline strip yes/no                        | **BUILT, SHIPPED OFF.** `PARTNER_STRIP_ENABLED=false` by default (documented in `.env.example`). Surfaces are allowlisted by import site: `/kampanii` index and `/igrishta/[city]` only. Turning it on is one env var; it is still your decision.                            |
| 3   | `/podkrepi` bank-only vs hosted payment link | **BUILT BOTH WAYS, defaulting to the recommendation.** Bank transfer only unless `DONATION_PAYMENT_URL` is set, which renders a link OUT to a processor-hosted page. No on-site payment code exists.                                                                         |
| 4   | "adopted by" as a declared open-data field   | **DECIDED NO** (the plan's own default). `facility_sponsorships` is off `ALLOWED_RELATIONS` and a live-DB test asserts the facility export is byte-identical with and without an adoption. Reversing this would be a deliberate catalogue entry.                             |
| 5   | Which streams to sell first                  | **OPEN — sales.** All of S1/S2/S3/S5 are now buildable-to-sellable; the recommendation (S1 + M4 slots together, S3 as the flagship pitch) is unchanged.                                                                                                                      |
| 6   | Sponsor exclusion list                       | **OPEN — board.** No code depends on it; it is a policy document plus operator judgement at the point of creating a partner row.                                                                                                                                             |
| 7   | Confirm the four ad slots                    | **BUILT AS SPECIFIED.** `facility_page`, `city_page`, `weekly_page`, `map_panel`. The list is closed in three agreeing places (the `AD_SLOTS` constant, the `ad_placements_slot_known` CHECK, and §S5's table), so adding or removing one is a deliberate edit in all three. |
| 8   | AD-2 network fill                            | **OFF, and nothing was built toward it.** The `AdSlot` component's own header states that making it fetch, measure or personalise is buying the consent banner and the privacy-page rewrite.                                                                                 |

## 7. Decisions needed from the operator before M1

1. Tier names and price anchors (§S1 table is a starting point).
2. Headline-partner strip on the allowlisted surfaces — yes/no.
3. `/podkrepi`: bank-transfer-only (recommended start) vs also an external
   hosted payment link.
4. Should "adopted by" ever appear in the open-data facility export as a
   declared field? (Default and recommendation: no.)
5. Which streams to actively sell first (recommendation: S1 + the M4 ad
   slots together — one pitch, two products; S3 as the flagship pitch).
6. The sponsor exclusion list (§S1) — confirm the categories; it applies to
   advertisers identically.
7. Confirm the four ad slots (§S5 table) — any to add or remove? Each
   addition is a deliberate decision recorded in that table.
8. AD-2 network fill: recommendation is OFF. Turning it on is a conscious
   purchase of a consent banner, third-party scripts, and a privacy-page
   rewrite (§S5).

---

## MANUAL STEPS (operator, offline/GUI)

- [ ] **Accountant**: confirm (a) дарение vs спонсорство invoicing per §1.2,
      (b) prize-tax handling for campaign prizes (10% withholding, чл. 55
      declarations; whether the 100 лв non-cash exemption applies to
      skill-based standings — post-euro restated figure), (c) VAT threshold
      tracking procedure (€51,130, daily, calendar-year, invoiced only).
- [ ] **Lawyer**: check the устав lists допълнителна стопанска дейност
      covering advertising and sponsorship services; amend if not. Confirm
      обществена полза registration status in the Registry Agency's НПО
      register (donor tax relief depends on it) and what the annual
      public-benefit filing will disclose about sponsorship/ad revenue.
      Confirm the labelling obligations for paid placements (the «Реклама»
      label — ЗЗП / е-търговия rules).
- [ ] Prepare the two contract templates (дарение / спонсорство-реклама) —
      reuse BCNL model documents where possible. Both carry the
      reputational termination clause; the реклама template names the slot,
      period and price; the спонсорство template names who awards prizes
      (→ who withholds the 10%).
- [ ] Draft the municipal consent/partnership memo template for S3
      adoptions (the facility owner's consent to funded upkeep +
      acknowledgment).
- [ ] Write down the sponsor acceptance policy (§S1) and get board sign-off
      on the exclusion list and the headline-tier approval rule.
- [ ] Draft the rate card from §S1/§S3 anchors; decide tier names.
- [ ] Build the pitch shortlist (Decathlon partnership programme, Lidl/
      Kaufland CSR, DSK/Postbank, Vivacom/A1, insurers) and check the next
      Erasmus+ Sport Small-scale Partnerships deadline.
- [ ] Re-verify the flagged legal figures before quoting them anywhere
      (article numbers for ЗХ skill-game exemption; euro restatement of the
      100 лв prize exemption; ЗМДТ donation-tax treatment).
