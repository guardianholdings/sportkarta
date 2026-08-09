import { toCsv } from '../csv.js';
import { instantToWall, SOFIA_TZ } from '../recurrence/index.js';

import type { ReportDefinition, ReportMetric, ReportTable } from './schema.js';
import { allMetrics, allTables, MIN_DISCLOSED, SUPPRESSED_LABEL } from './schema.js';

/**
 * Rendering a report to print-ready HTML and to annex CSV (Stage 6.2).
 *
 * SELF-CONTAINED AND SCRIPT-FREE, like the municipality widget in 3.4 and for
 * an overlapping reason: this document is emailed, attached to a grant file,
 * printed, and opened on a ministry laptop years from now. Inline CSS, no
 * external font, no image, no script — a report that needs our server to be up
 * in order to render is not a document, it is a screenshot with extra steps.
 *
 * THE METHODOLOGY SECTION IS NOT AN APPENDIX, IT IS THE POINT. Every figure's
 * definition and its exact SQL are printed at the end, generated from the same
 * catalogue that produced the numbers. "Where does 1 284 come from?" is
 * answerable by somebody who has our database and not our source code, which is
 * the difference between a figure and a claim.
 *
 * `@page` is A4 with real margins and the section headings avoid breaking away
 * from their tables, because the PDF path is Chromium's print engine
 * (scripts/quarterly-report) and the browser's own Print dialog for the admin
 * export — both honour these rules.
 */

export interface ReportScope {
  /** Inclusive start, ISO instant. */
  from: string;
  /** EXCLUSIVE end, ISO instant. */
  to: string;
  /** Bulgarian municipality name, or null for the national scope. */
  municipalityNameBg: string | null;
  /** ISO instant the figures were computed. */
  generatedAt: string;
}

export interface MetricValue {
  metricId: string;
  /** null when the query returned no row — distinct from zero. */
  value: number | null;
}

export interface TableRows {
  tableId: string;
  rows: Record<string, unknown>[];
}

export interface ReportData {
  scope: ReportScope;
  metrics: MetricValue[];
  tables: TableRows[];
}

const NATIONAL_LABEL = 'Национален обхват';

/** Bulgarian uses a space as the thousands separator. */
function formatNumber(value: number, unit: ReportMetric['unit']): string {
  const rounded = unit === 'percent' || unit === 'per10k' ? value.toFixed(1) : String(value);
  const [whole, fraction] = rounded.split('.');
  const grouped = (whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const joined = fraction ? `${grouped},${fraction}` : grouped;
  return unit === 'percent' ? `${joined}%` : joined;
}

/**
 * Whether a figure is withheld.
 *
 * ZERO IS NEVER SUPPRESSED, and the distinction matters: "nobody did this" is
 * not disclosive about anybody, while "one person did this" in a named
 * municipality is. Suppressing zero would also make a real absence look like a
 * privacy redaction, which is a worse reading of the same document.
 */
export function isSuppressed(
  definition: ReportDefinition,
  metric: ReportMetric,
  value: number | null,
): boolean {
  if (!definition.suppressSmallCounts || !metric.personDerived) return false;
  return value !== null && value > 0 && value < MIN_DISCLOSED;
}

/** A missing row is `—`, never 0: "not measured" is a different claim. */
function displayValue(
  definition: ReportDefinition,
  metric: ReportMetric,
  value: number | null,
): string {
  if (isSuppressed(definition, metric, value)) return SUPPRESSED_LABEL;
  if (value === null) return '—';
  return formatNumber(value, metric.unit);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The CIVIL SOFIA date of an instant, as `YYYY-MM-DD`.
 *
 * Reading `iso.slice(0, 10)` — the UTC date — is wrong here, and was wrong in
 * the first draft of this file until the rendering tests caught it. A quarter
 * that begins at midnight in Sofia is an instant at 21:00 UTC on the PREVIOUS
 * day, so the naive slice printed "31.03.2026 – 29.06.2026" across the top of a
 * document covering April to June. Every boundary in this feature is civil
 * Sofia time (period.ts), and the header has to agree with the numbers under it.
 */
export function sofiaDay(iso: string): string {
  const wall = instantToWall(new Date(iso).getTime(), SOFIA_TZ);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(wall.year)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** dd.mm.yyyy, the form a Bulgarian document uses. */
function formatDay(iso: string): string {
  return sofiaDay(iso).split('-').reverse().join('.');
}

/**
 * The end of the window is stored EXCLUSIVE and printed INCLUSIVE.
 *
 * A period labelled "01.04 – 01.07" reads as three months and a day, and the
 * off-by-one lands in a document somebody signs. The compiler takes an
 * exclusive bound because that is the only way to include the last day's final
 * microsecond without depending on a column's precision; the reader is shown
 * the last day actually covered.
 *
 * ONE MILLISECOND back, not one day: subtracting a day and reading the result
 * is the same UTC-vs-Sofia error as above, and lands a day early whenever the
 * bound is a Sofia midnight — which it always is.
 */
function printableEnd(toIso: string): string {
  return formatDay(new Date(new Date(toIso).getTime() - 1).toISOString());
}

/** `YYYY-MM-DD` of the last day covered — for filenames. */
function endDayIso(toIso: string): string {
  return sofiaDay(new Date(new Date(toIso).getTime() - 1).toISOString());
}

const STYLE = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: "DejaVu Sans", "Helvetica Neue", Arial, sans-serif;
         font-size: 10.5pt; line-height: 1.45; color: #111; margin: 0; }
  h1 { font-size: 17pt; margin: 0 0 2mm; }
  h2 { font-size: 12pt; margin: 8mm 0 2mm; border-bottom: 1px solid #999; padding-bottom: 1mm;
       break-after: avoid; page-break-after: avoid; }
  h3 { font-size: 10.5pt; margin: 4mm 0 1mm; break-after: avoid; page-break-after: avoid; }
  p { margin: 0 0 2mm; }
  .scope { font-size: 9.5pt; color: #333; margin-bottom: 3mm; }
  .scope strong { font-weight: 600; }
  .preamble { font-size: 9pt; color: #333; background: #f4f4f4; padding: 3mm;
              border-left: 3px solid #999; margin-bottom: 4mm; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 3mm; break-inside: auto; }
  th, td { text-align: left; padding: 1.4mm 2mm; border-bottom: 1px solid #ddd;
           vertical-align: top; }
  th { font-weight: 600; background: #f4f4f4; font-size: 9.5pt; }
  td.value { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .note { font-size: 8.5pt; color: #666; }
  .methodology { margin-top: 8mm; }
  .methodology h2 { break-before: page; page-break-before: always; }
  .method-entry { margin-bottom: 4mm; break-inside: avoid; page-break-inside: avoid; }
  .method-entry .label { font-weight: 600; }
  pre { font-family: "DejaVu Sans Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 8pt; background: #f7f7f7; border: 1px solid #e0e0e0; padding: 2mm;
        white-space: pre-wrap; word-break: break-word; margin: 1mm 0 0; }
  footer { margin-top: 6mm; font-size: 8.5pt; color: #666;
           border-top: 1px solid #ccc; padding-top: 2mm; }
`;

function metricRows(
  definition: ReportDefinition,
  metrics: readonly ReportMetric[],
  values: Map<string, number | null>,
): string {
  return metrics
    .map((metric) => {
      const value = values.get(metric.id) ?? null;
      // Shown only where somebody could actually be holding municipal annexes
      // to add up; see ReportDefinition.municipalityScoped.
      const marker =
        metric.additive || !definition.municipalityScoped
          ? ''
          : ' <span class="note">(не се сумира между общини)</span>';
      return `<tr><td>${escapeHtml(metric.labelBg)}${marker}</td><td class="value">${escapeHtml(
        displayValue(definition, metric, value),
      )}</td></tr>`;
    })
    .join('\n');
}

function tableBlock(table: ReportTable, rows: Record<string, unknown>[]): string {
  const head = table.columnsBg.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const body = rows.length
    ? rows
        .map(
          (row) =>
            `<tr>${table.columns
              .map((column, index) => {
                const raw = row[column];
                const text = raw === null || raw === undefined ? '—' : String(raw);
                return `<td${index === 0 ? '' : ' class="value"'}>${escapeHtml(text)}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('\n')
    : `<tr><td colspan="${String(table.columnsBg.length)}">Няма данни за периода</td></tr>`;
  return `<h3>${escapeHtml(table.titleBg)}</h3>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function methodology(definition: ReportDefinition): string {
  const entries = [
    ...allMetrics(definition).map(({ metric }) => ({
      label: metric.labelBg,
      definitionBg: metric.definitionBg,
      sql: metric.sql,
    })),
    ...allTables(definition).map(({ table }) => ({
      label: table.titleBg,
      definitionBg: table.definitionBg,
      sql: table.sql,
    })),
  ];
  return `<section class="methodology">
<h2>Методология</h2>
<p class="note">Всеки показател по-долу е придружен от точната заявка, с която е изчислен. Заявките се изпълняват срещу производствената база данни; параметрите <code>:from</code> и <code>:to</code> са началото и краят на периода, а <code>:municipality</code> е кодът на общината (или празно за национален обхват).</p>
${entries
  .map(
    (entry) => `<div class="method-entry">
<div class="label">${escapeHtml(entry.label)}</div>
<div class="note">${escapeHtml(entry.definitionBg)}</div>
<pre>${escapeHtml(entry.sql.trim())}</pre>
</div>`,
  )
  .join('\n')}
</section>`;
}

/**
 * The full document. `<!doctype html>` included: this file is written to disk
 * and opened directly, not served through a framework that would add one.
 */
export function renderReportHtml(definition: ReportDefinition, data: ReportData): string {
  const values = new Map(data.metrics.map((m) => [m.metricId, m.value]));
  const tables = new Map(data.tables.map((t) => [t.tableId, t.rows]));
  const scopeLabel = data.scope.municipalityNameBg
    ? `Община ${data.scope.municipalityNameBg}`
    : NATIONAL_LABEL;

  const body = definition.sections
    .map((section) => {
      const metrics = section.metrics?.length
        ? `<table><thead><tr><th>Показател</th><th class="value">Стойност</th></tr></thead>
<tbody>${metricRows(definition, section.metrics, values)}</tbody></table>`
        : '';
      const blocks = (section.tables ?? [])
        .map((table) => tableBlock(table, tables.get(table.id) ?? []))
        .join('\n');
      return `<section><h2>${escapeHtml(section.titleBg)}</h2>${metrics}${blocks}</section>`;
    })
    .join('\n');

  const suppression = definition.suppressSmallCounts
    ? `<p class="note">Показателите, изведени от хора, се потискат при стойност под ${String(MIN_DISCLOSED)} и се отбелязват като „${SUPPRESSED_LABEL}“. Нулата не се потиска.</p>`
    : '';

  return `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8">
<title>${escapeHtml(definition.titleBg)} — ${escapeHtml(scopeLabel)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(definition.titleBg)}</h1>
<p class="scope">
  <strong>Обхват:</strong> ${escapeHtml(scopeLabel)}<br>
  <strong>Период:</strong> ${escapeHtml(formatDay(data.scope.from))} – ${escapeHtml(
    printableEnd(data.scope.to),
  )} (включително)<br>
  <strong>Изготвен на:</strong> ${escapeHtml(formatDay(data.scope.generatedAt))}
</p>
<div class="preamble">${escapeHtml(definition.preambleBg)}</div>
${suppression}
${body}
${methodology(definition)}
<footer>Данни за площадките: © OpenStreetMap contributors + POPS community (ODbL 1.0).</footer>
</body>
</html>`;
}

/**
 * The annex CSV.
 *
 * TALL, NOT WIDE — one row per figure. A wide row would change shape every time
 * a metric is added, which breaks whatever the ministry pastes it into; a tall
 * table just gets longer.
 *
 * THE SCOPE IS REPEATED ON EVERY ROW, and that redundancy is deliberate. Stage
 * 6.1 established that a CSV cannot carry a header block without ceasing to be
 * a CSV — so the period and the municipality, without which an annex is not
 * merely less useful but unfileable, travel as columns. A filed document that
 * cannot say what period it covers is worse than three repeated columns.
 *
 * Writing goes through lib/src/csv.ts, which is RFC 4180 and formula-safe.
 */
export function renderReportCsv(definition: ReportDefinition, data: ReportData): string {
  const values = new Map(data.metrics.map((m) => [m.metricId, m.value]));
  const scopeLabel = data.scope.municipalityNameBg ?? NATIONAL_LABEL;

  const header = [
    'Период от',
    'Период до',
    'Обхват',
    'Раздел',
    'Код',
    'Показател',
    'Стойност',
    'Мерна единица',
    'Сумируем между общини',
    'Определение',
  ];

  const unitLabel: Record<ReportMetric['unit'], string> = {
    count: 'брой',
    percent: 'процент',
    per10k: 'на 10 000 жители',
    days: 'дни',
  };

  const rows = allMetrics(definition).map(({ section, metric }) => {
    const value = values.get(metric.id) ?? null;
    const cell = isSuppressed(definition, metric, value)
      ? SUPPRESSED_LABEL
      : value === null
        ? ''
        : String(value);
    return [
      formatDay(data.scope.from),
      printableEnd(data.scope.to),
      scopeLabel,
      section.titleBg,
      metric.id,
      metric.labelBg,
      cell,
      unitLabel[metric.unit],
      metric.additive ? 'да' : 'не',
      metric.definitionBg,
    ];
  });

  // BOM: Excel on a Bulgarian Windows locale is the actual consumer, and
  // without it every Cyrillic label opens as mojibake.
  return '﻿' + toCsv([header, ...rows]) + '\r\n';
}

/** Suggested filename stem, e.g. `otchet-grant-sofia-2026-04-01_2026-06-30`. */
export function reportFilename(definition: ReportDefinition, scope: ReportScope): string {
  const place = scope.municipalityNameBg ? 'obshtina' : 'natsionalen';
  // Civil Sofia days at both ends, matching what the document prints.
  return `otchet-${definition.id}-${place}-${sofiaDay(scope.from)}_${endDayIso(scope.to)}`;
}
