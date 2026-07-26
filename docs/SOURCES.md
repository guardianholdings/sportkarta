# External data sources — operator playbook

The machine-readable catalogue is `lib/src/external-sources/catalog.ts`; this
page is the human process around it. The rule of the house: **no new writers.**
A facility-bearing dataset becomes a CSV for the municipal inbox
(`/admin/obshtini`), which already does distance+name dedupe, the
crowd > municipal > osm merge policy, and per-row conflict review. Entities
(clubs, coaches, schools) never become facility rows directly. A dataset's
license string is recorded in the catalogue **when it is adopted**, before the
first row is imported.

## The sources

| Source | What it is | Path into SportKarta | Blocked on |
|---|---|---|---|
| **Регистър на спортните обекти** (чл. 9, ал. 1, т. 3 ЗФВС) — mysregisters.egov.bg | The official national register: ~4,980 facilities (name, type, settlement, address, област, sport, status); CC0 CSV snapshots on data.egov.bg | **ADOPTED 2026-07-25**: name crosscheck + inbox name-fills + ambassador coverage-gap worklist (docs/enrichment/2026-07/) | Nothing — CC0. No coordinates: rows resolve via EKATTE + corpus matching, never direct import |
| ММС регистри — организации и кадри | Clubs/federations at registers.mpes.government.bg; **coaches** at staff.mpes.government.bg (corrected 2026-07-25); same data as CC0 CSVs on data.egov.bg | Entities layer: club directory, "clubs training here", outreach lists | Nothing legal — CC0 on data.egov.bg; just build order |
| Уикиданни (query.wikidata.org) | 140 BG sports venues with coordinates, 62 with photo; CC0 | **ADOPTED 2026-07-25** (assistive): coordinate-verified name fills applied via the admin edit screen | Nothing for names; photos see the Commons row |
| Уикимедия Общомедия | Per-file-licensed venue photos, discoverable via Wikidata P18/P373 + geosearch | Assistive: photo candidates for matched venues (54 in docs/enrichment/2026-07/wikidata-matches.csv) | **Schema**: `facility_photos` lacks license/attribution/source columns — migration first |
| data.egov.bg | Portal; category „Образование, култура и спорт“; small municipalities (Драгоман, Николаево, Търговище, Самуил, Куклен…) publish own спортни обекти CSVs, mostly CC0 | Sport datasets → municipal inbox CSV | Per-dataset survey; license string per dataset |
| НСИ (nsi.bg/nrnm + Infostat) | Population by община (annual); НРНМ/ЕКАТТЕ (265 общини / 5,256 населени места) — zip endpoint `nsi.bg/nrnm/ekatte/zip/download?files_type=excel` | EKATTE settlement→municipality already used by the enrichment matching (2026-07-25); still to do: refresh `municipality_population` + the checked-in EKATTE reference | Nothing — free reuse with attribution |
| Софияплан (sofiaplan.bg/api) | ~399 free-licensed datasets incl. спортни и детски площадки; documented JSON API | The Sofia seed → municipal inbox CSV; the template ask for every other municipality | **Outreach first** — they are a natural ally („София спортува“); don't just scrape |
| МОН Регистър на институциите (ri.mon.bg) | Every school/kindergarten with addresses | Geocode (Photon) → candidate school-yard facilities, `access=school`, `needs_verification` → municipal inbox | ЗДОИ for export; scrape as fallback |
| INSPIRE портал | National spatial data portal | Admin boundaries cross-check, orthophoto for verification | Layer survey |

## Operator steps (in order of value)

1. **НСИ** (no blockers): download the current население по общини table and
   the NRNM/EKATTE register; hand them to a session to refresh
   `municipality_population` and the EKATTE reference. License: „свободно
   използване с посочване на източника“ — already compatible.
2. **Софияплан**: write to Софияплан referencing „София спортува“, ask for the
   спортни площадки dataset (and detski ploshtadki if wanted) as export or
   blessed API use. On yes: a session converts the GeoJSON to the municipal
   inbox CSV and it goes through the normal preview → conflict review → commit.
3. **data.egov.bg**: survey the category via the CKAN API, shortlist datasets,
   record each dataset's license string in the catalogue on adoption.
4. **ЗДОИ ×1**: file a request to МОН (institution register export). The ММС
   club/facility registers turned out to be CC0 on data.egov.bg (2026-07-25) —
   ЗДОИ to ММС only if the facilities register's non-public fields (owner,
   cadastral id) become needed.
5. **INSPIRE**: survey once, adopt boundary/orthophoto layers only if they beat
   what OSM already provides.

## What this is NOT

- Not a new import pipeline: everything facility-shaped funnels through the
  municipal inbox and its merge policy.
- Not a PII channel: club/coach registers are entities; person-level data
  (треньорски кадри) is used for outreach only and never enters the public
  corpus (the open-data denylist and relation allowlist stay untouched).
- Private/commercial venues are a separate track: OSM (`fitness_centre`,
  `sports_centre`, `access=customers`, `fee=yes`) imports them as
  `access='paid'`, gated by the 0018 master + per-business switches in
  `/admin/chastni`.
