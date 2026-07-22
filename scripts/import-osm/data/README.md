# Reference data

## ekatte-municipalities.csv

The 265 Bulgarian municipalities from the official EKATTE register
(Единен класификатор на административно-териториалните и териториалните
единици), Национален статистически институт.

- Source: <https://www.nsi.bg/nrnm/ekatte/archive/excel/Ekatte-2025-excel.zip>
  (file `ek_obst.xlsx`; register data current as of 2022-07-08 per the file
  header, retrieved 2026-07-22)
- Columns: `ekatte_code` (register municipality code, e.g. `SOF46`),
  `name_bg` (official name), `name_en` (the register's own transliteration)
- Regenerate after an NSI update: download the newest archive from
  <https://www.nsi.bg/nrnm/ekatte/archive>, then run
  `python3 convert-ek-obst.py <path-to-ek_obst.xlsx>` in this directory.

The importer NEVER fuzzy-guesses a municipality: an OSM boundary whose
normalized name has no exact register match is skipped and flagged in the
run report for an operator decision.

## municipality-name-overrides.csv

Operator-decided mappings for OSM boundary relations whose names do not
uniquely match a register `name_bg` after normalization (see
`municipalities.ts`). Columns: `osm_relation_id,ekatte_code` — keyed by
relation id because names can be ambiguous (two municipalities are both
named „Бяла“). Every row here is a deliberate human decision — append via
session review, never automatically.
