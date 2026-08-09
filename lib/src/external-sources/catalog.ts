/**
 * External data sources — the CATALOGUE (2026-07-25, operator brief).
 *
 * Like open data and reports, sources are declared once, here, and everything
 * else reads this array: the docs page/playbook (docs/SOURCES.md mirrors it),
 * future importers, and the per-dataset license bookkeeping. A dataset's
 * license string is recorded HERE when it is adopted — before a single row is
 * imported — because reuse terms are part of provenance, not an afterthought.
 *
 * Ingestion paths are the EXISTING writers only:
 *   'municipal-inbox' — facility-bearing datasets become CSV for the Stage 6.3
 *     inbox (/admin/obshtini): dedupe + merge policy + per-row conflict review
 *     already live there. No new writer is built for a new source.
 *   'reference'      — replaces checked-in reference data (EKATTE, population).
 *   'entities'       — clubs/coaches/schools: NOT facilities; they become
 *     directory/outreach layers, never facility rows.
 *   'osm'            — already flowing through scripts/import-osm.
 *   'assistive'      — crosscheck material only: matches/reports an operator
 *     applies through the admin edit screen (provenance 'crowd', real actor).
 *     Never a bulk writer.
 *
 * Statuses are honest about access reality: 'ready' has a documented API,
 * 'needs-zdoi' means a ЗДОИ (FOI) request the OPERATOR files, 'needs-outreach'
 * means approach the institution — scraping is the fallback, not the plan.
 */

export type IngestPath = 'municipal-inbox' | 'reference' | 'entities' | 'osm' | 'assistive';
export type SourceStatus = 'ready' | 'candidate' | 'needs-zdoi' | 'needs-outreach';

export interface ExternalSource {
  /** Stable id, kebab-case. */
  readonly id: string;
  readonly nameBg: string;
  readonly operator: string;
  readonly url: string;
  /** How the data is reached today (API, download, web register). */
  readonly access: string;
  /** Reuse terms; per-dataset strings recorded verbatim when adopted. */
  readonly license: string;
  /** What SportKarta uses it for. */
  readonly use: string;
  readonly ingestPath: IngestPath;
  readonly status: SourceStatus;
  readonly notes?: string;
}

export const EXTERNAL_SOURCES: readonly ExternalSource[] = [
  {
    id: 'mms-sports-facilities',
    nameBg: 'Регистър на спортните обекти (чл. 9, ал. 1, т. 3 ЗФВС)',
    operator: 'Министерство на младежта и спорта',
    url: 'https://mysregisters.egov.bg/MMSExt/public/registerSO.xhtml',
    access:
      'Live public app (~4,980 records, Excel/PDF/CSV export, no login) + CC0 CSV snapshots on data.egov.bg (dataset 96f3b27f-c828-4e75-9792-a18a88faa529, newest seen 02.2025). Columns: рег. номер, наименование, вид, населено място, адрес, област, спорт, вписване. NO coordinates — rows resolve to municipalities via the NSI EKATTE register, then match against the corpus (docs/enrichment/).',
    license:
      'Условия за предоставяне на информация без защитени авторски права (CC0) — recorded verbatim from data.egov.bg on adoption, 2026-07-25.',
    use: 'Official names crosscheck + name fills through the inbox; coverage-gap worklist for ambassadors (first run: docs/enrichment/2026-07/).',
    ingestPath: 'municipal-inbox',
    status: 'ready',
    notes:
      'ADOPTED 2026-07-25. Наредба № 1/05.02.2020 чл. 22 says records also hold owner + cadastral id — absent from the public CSV; ЗДОИ (pitay.government.bg, 14-day term) only if those fields become needed.',
  },
  {
    id: 'mms-registers',
    nameBg: 'Регистри на ММС по чл. 9 ЗФВС (организации и кадри)',
    operator: 'Министерство на младежта и спорта',
    url: 'http://registers.mpes.government.bg/registers',
    access:
      'Clubs/federations at registers.mpes.government.bg (JS tables, no export; https redirects to http); coaches at staff.mpes.government.bg (чл. 9, т. 4). Same data as CC0 CSVs on data.egov.bg (org 108) — no ЗДОИ needed.',
    license: 'CC0 via the data.egov.bg datasets; web apps state no terms.',
    use: 'Official club directory → club profiles, "clubs training at this facility", partnership outreach lists.',
    ingestPath: 'entities',
    status: 'candidate',
    notes:
      'Entities, not facilities: never becomes facility rows directly. (Corrected 2026-07-25: staff.mpes is the COACHES register, not clubs.)',
  },
  {
    id: 'wikidata',
    nameBg: 'Уикиданни — спортни съоръжения в България',
    operator: 'Wikimedia Foundation / общност',
    url: 'https://query.wikidata.org/sparql',
    access:
      'SPARQL endpoint (GET, JSON). 140 Bulgarian sports venues with coordinates in the stadium/sports-venue class tree; 62 with Commons image (P18), 105 with Bulgarian label. Query preserved in docs/enrichment/2026-07/.',
    license: 'CC0 (Wikidata data) — names import freely, no attribution obligation.',
    use: 'Coordinate-verified name crosscheck/fills for notable venues; P18/P373 as the curated photo-discovery route.',
    ingestPath: 'assistive',
    status: 'ready',
    notes:
      'ADOPTED 2026-07-25 (crosscheck only). ~2% of the corpus by size — big named venues, not neighbourhood facilities.',
  },
  {
    id: 'wikimedia-commons',
    nameBg: 'Уикимедия Общомедия — снимки на съоръжения',
    operator: 'Wikimedia Foundation / общност',
    url: 'https://commons.wikimedia.org/w/api.php',
    access:
      'Per-file licenses via imageinfo/extmetadata (LicenseShortName, LicenseUrl, Artist, Attribution, Restrictions); discovery via Wikidata P18/P373 (curated) or geosearch (noisy — plaques/events near the point, needs human review).',
    license:
      'Per-file (CC0/PD/CC BY/CC BY-SA …) — gate on an allowlist; CC BY-SA 4.0 §2(a)(4) permits our webp re-encode + EXIF strip (format shift is never Adapted Material); required bookkeeping per photo: author, license name+URI, source URL, modification note.',
    use: 'Facility photos for matched venues (54 candidates in docs/enrichment/2026-07/wikidata-matches.csv).',
    ingestPath: 'assistive',
    status: 'candidate',
    notes:
      'BLOCKED on schema: facility_photos has no license/attribution/source columns — importing before that migration would strip legally required attribution.',
  },
  {
    id: 'data-egov-bg',
    nameBg: 'Портал за отворени данни',
    operator: 'Министерство на електронното управление',
    url: 'https://data.egov.bg',
    access:
      'CKAN-style portal with API; category „Образование, култура и спорт“; HVD program ramping up.',
    license: 'Per-dataset — mostly free reuse; record the license string per adopted dataset here.',
    use: 'Sport-facility datasets → municipal inbox; cleaned ЕКАТТЕ + postal codes (≈5,257 territorial units) as reference.',
    ingestPath: 'municipal-inbox',
    status: 'candidate',
  },
  {
    id: 'nsi',
    nameBg: 'НСИ — население и ЕКАТТЕ',
    operator: 'Национален статистически институт',
    url: 'https://www.nsi.bg/nrnm',
    access:
      'Infostat + open tables (annual population by област/община/населено място); Национален регистър на населените места (265 общини, 5,256 населени места, updated Dec 2025).',
    license: 'Free reuse with attribution (НСИ).',
    use: 'Replaces the checked-in municipality_population CSV (per-10k stats) and the hand-maintained EKATTE reference.',
    ingestPath: 'reference',
    status: 'ready',
  },
  {
    id: 'sofiaplan',
    nameBg: 'Софияплан — отворени данни',
    operator: 'ОП „Софияплан“, Столична община',
    url: 'https://sofiaplan.bg/api',
    access:
      'GIS portal with a documented JSON API; ~399 datasets incl. спортни и детски площадки, училища, детски градини, паркове.',
    license: 'Free license (per portal); record the exact string per adopted dataset.',
    use: 'The single best municipal seed for Sofia; the template request for other municipalities. Their „София спортува“ strategy work makes them an institutional ally.',
    ingestPath: 'municipal-inbox',
    status: 'needs-outreach',
    notes: 'Approach, do not just scrape — partnership beats one-off ingestion.',
  },
  {
    id: 'mon-institutions',
    nameBg: 'МОН — Регистър на институциите',
    operator: 'Министерство на образованието и науката',
    url: 'https://ri.mon.bg',
    access:
      'Web register (every state/municipal/private school and kindergarten with addresses); scrape + ЗДОИ for export.',
    license: 'Public register; reuse terms unstated — record per ЗДОИ response.',
    use: 'Geocode via Photon → candidate school-yard facilities (access=school, status=needs_verification) + the school-vs-school challenge layer.',
    ingestPath: 'municipal-inbox',
    status: 'needs-zdoi',
  },
  {
    id: 'inspire-portal',
    nameBg: 'Национален портал за пространствени данни',
    operator: 'Държавна агенция „Електронно управление“ (INSPIRE)',
    url: 'https://inspire.egov.bg',
    access:
      'INSPIRE national spatial data portal — administrative boundaries and orthophoto layers.',
    license: 'INSPIRE terms per layer; record per adopted layer.',
    use: 'Secondary source: administrative boundaries cross-check, orthophoto for verification.',
    ingestPath: 'reference',
    status: 'candidate',
  },
] as const;
