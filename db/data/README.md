# db/data — reference datasets

## population.csv

Municipality **population** (2021 census), keyed by `ekatte_code` (matching
`municipalities.ekatte_code`). Drives the "facilities per 10,000 residents"
metric on `/statistika`, `/obshtina/[city]` and the embeddable widget.

- **Source:** Национален статистически институт (НСИ) — Преброяване на
  населението и жилищния фонд 2021 г., население към 7.09.2021 г. по общини.
  National Statistical Institute (NSI), 2021 Census, population on 7 September
  2021 by municipality. Official table: ИС ИНФОСТАТ, „Население по области,
  общини и единична възраст към 7.09.2021 година“
  (<https://www.nsi.bg/infostat/2090>), filtered to all 265 municipalities and
  age „Общо“; retrieved 2026-09-30. The 265 figures sum to the census national
  total, 6 519 789.
- **Coverage:** all 265 municipalities, keyed by the table's own municipality
  codes, which are the EKATTE register codes in
  `scripts/import-osm/data/ekatte-municipalities.csv` (every code and name
  matches). Until 2026-09-30 this file held five launch municipalities, four of
  them with figures that were not the census count; they were replaced with the
  table's values.
- **Accuracy rule (CLAUDE.md / ROADMAP):** the per-10k figure is computed
  deterministically as `facilities ÷ (population / 10000)` and reconciles with a
  direct query in the test suite. A municipality **absent** from this file shows
  "no data" on the site — population is never estimated or interpolated.
  `db/src/population-data.test.ts` fails if a register municipality is
  missing, a code is unknown, or the national total or any of the 28 region
  totals drifts from NSI's final-results release («Население към 7 септември
  2021 година. Окончателни данни», `Census2021_population.pdf` on nsi.bg) — a
  second NSI publication, so a typo or a transposed row cannot pass.
- **Updating:** replace the figures from the same NSI table (or its successor
  for the next census), keep the header and the code column, and update the
  expected totals in the test.

Format: `ekatte_code,population` (integer). Loaded into the
`municipality_population` table by `db/scripts/load-population.ts` (run via
`pnpm db:seed`).
