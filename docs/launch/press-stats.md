# SportKarta — launch press statistics

_Generated 2026-07-22 by `pnpm stats:launch-report` (scripts/launch-report)._

Every figure below is produced by the **exact SQL query** shown beneath it, run
against the live database — reproducible and verifiable by anyone. The numbers
reconcile with the [/statistika](../../apps/web/app/[locale]/statistika) page
(its materialized views derive from the same base data). Facility data ©
OpenStreetMap contributors (ODbL); municipality population from NSI (2021
Census, see db/data/README.md). Regenerate against production at launch.

## Public sports facilities on the map

**6587**

```sql
SELECT count(*) AS n FROM facilities WHERE status <> 'gone';
```

## Facilities with free public access (%)

**90.6%**

```sql
SELECT round(100.0 * count(*) FILTER (WHERE access = 'free') / count(*), 1) AS pct
FROM facilities WHERE status <> 'gone';
```

## Municipalities with at least one facility

**263**

```sql
SELECT count(DISTINCT municipality_id) AS n
FROM facilities WHERE status <> 'gone' AND municipality_id IS NOT NULL;
```

## Distinct sports represented

**27**

```sql
SELECT count(DISTINCT s.sport) AS n
FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
WHERE f.status <> 'gone';
```

## Awaiting community verification (%)

**99.9%**

```sql
SELECT round(100.0 * count(*) FILTER (WHERE status = 'needs_verification') / count(*), 1) AS pct
FROM facilities WHERE status <> 'gone';
```

## Top 5 municipalities by facility count

**Столична (1730), Варна (405), Пловдив (312), Бургас (217), Несебър (171)**

```sql
SELECT m.name_bg, count(*) AS n
FROM facilities f JOIN municipalities m ON m.id = f.municipality_id
WHERE f.status <> 'gone'
GROUP BY m.id, m.name_bg ORDER BY n DESC, m.name_bg LIMIT 5;
```

## Best-covered municipality — facilities per 10,000 residents (cities with population data)

**Столична — 13.58 per 10k**

```sql
SELECT name_bg, per_10k FROM mv_municipality_stats
WHERE per_10k IS NOT NULL ORDER BY per_10k DESC LIMIT 1;
```
