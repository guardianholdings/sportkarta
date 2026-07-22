# db/data — reference datasets

## population.csv

Municipality **permanent population**, keyed by `ekatte_code` (matching
`municipalities.ekatte_code`). Drives the "facilities per 10,000 residents"
metric on `/statistika`.

- **Source:** Национален статистически институт (НСИ) — Преброяване на
  населението и жилищния фонд 2021 г., постоянно население по общини.
  National Statistical Institute (NSI), 2021 Census, permanent population by
  municipality — <https://www.nsi.bg/>.
- **Coverage:** launch municipalities only (Sofia, Plovdiv, Varna, Burgas,
  Ruse). This file is the **editable source of record** — a native-speaking
  operator should verify these figures against the official NSI release and
  extend the file to the remaining municipalities.
- **Accuracy rule (CLAUDE.md / ROADMAP):** the per-10k figure is computed
  deterministically as `facilities ÷ (population / 10000)` and reconciles with a
  direct query in the test suite. Municipalities **absent** from this file show
  **"n/a"** on the site — population is never estimated or interpolated.

Format: `ekatte_code,population` (integer). Loaded into the
`municipality_population` table by `db/scripts/load-population.ts` (run via
`pnpm db:seed`).
