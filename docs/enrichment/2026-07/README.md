# Facility enrichment run — 2026-07-25

Crosscheck of the 6,605-facility corpus (test fixtures excluded) against two
newly adopted CC0 sources, per the docs/SOURCES.md rule: facility data flows
ONLY through the existing writers (municipal inbox / admin edit screen),
license recorded in `lib/src/external-sources/catalog.ts` before import.

## Sources used

1. **ММС Регистър на спортните обекти** (чл. 9, ал. 1, т. 3 ЗФВС) — CC0 CSV
   snapshot 02.2025 from data.egov.bg (dataset
   `96f3b27f-c828-4e75-9792-a18a88faa529`); 4,918 records, 3,267 active
   („Вписан"). No coordinates — rows were resolved to municipalities via the
   NSI EKATTE register (settlement + област → община; 3,130 resolved, 96%).
2. **Wikidata** (CC0) — all 140 Bulgarian sports venues with coordinates
   (stadium/sports-venue/arena class tree), 62 with a Commons image.
3. **NSI НРНМ/ЕКАТТЕ** (free reuse with attribution) — settlement→municipality
   mapping, snapshot built 2026-07-25, data current to 15.05.2026.

## Files and what to do with each

| File                   | Rows  | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mms-name-fills.csv`   | 12    | **Upload at `/admin/obshtini`**, registry label: `ММС регистър спортни обекти (CC0, 02.2025)`. Each row carries the register's official name at OUR facility's coordinates with all current field values (so nothing else changes — an empty cell would ERASE data, hence full rows). Expect every row to classify as CONFLICT (`same_spot_different_name` at 0 m, because the facility is unnamed) — review each, resolve as **link** to the shown facility. The `__facility_id`/`__reg_num` columns are the audit trail; the inbox ignores unknown columns. |
| `mms-crosscheck.csv`   | 151   | Report. 50 `confirmed` (our name matches the register), 101 `name_differs` — the register's official name next to ours. Apply selectively via the admin facility edit screen (provenance `crowd`, real actor); do NOT bulk-apply: some pair a complex with its sub-facility (e.g. our tennis court vs the register's «Спортен комплекс»).                                                                                                                                                                                                                     |
| `wikidata-matches.csv` | 140   | Report. 119 matched within 250 m: 65 `name_fill` (unnamed facility at a known venue — apply via admin edit), 26 `confirmed`, 28 `review`. 54 matches have a Commons image (`image` column) — photo import is BLOCKED until `facility_photos` gains license/attribution columns (see follow-ups). `our_wikidata_tag` shows the 25 OSM-anchored matches.                                                                                                                                                                                                        |
| `coverage-gaps.csv`    | 2,873 | Ambassador worklist: active register facilities with no plausible corpus counterpart in their municipality. Many are indoor bases, school halls and club facilities OSM never mapped — each is a candidate for the crowd add-facility flow with on-the-ground verification.                                                                                                                                                                                                                                                                                   |
| `stats.json`           | —     | All run numbers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Quality gates applied to the name fills

- Municipality-level uniqueness on BOTH sides (exactly one register facility
  of the type, exactly one unnamed corpus candidate matching the type).
- Type predicates: стадион→soccer, зала→covered/sports_centre minus
  pools, басейн→swimming, тенис→tennis.
- Register sport column must not contradict our sport list (13 rejected).
- Purely generic register names («Стадион», «Спортна зала»…) rejected — a
  generic name is worse than a generated label (13 rejected).

## Method caveats

- The ММС snapshot is 02.2025 (newest CC0 resource); the live register at
  `mysregisters.egov.bg/MMSExt/public/registerSO.xhtml` (4,980 records) has
  CSV export for fresher pulls.
- Settlement→municipality resolution is exact-name based; 26 settlements
  unresolved, 5 ambiguous (duplicate village names within one област) —
  their rows appear in no output except coverage-gaps with empty municipality.
- Tier-B matches assert identity WITHOUT coordinate evidence from the
  register side (it has none). That is why they enter through the inbox's
  per-row conflict review instead of being applied directly.
