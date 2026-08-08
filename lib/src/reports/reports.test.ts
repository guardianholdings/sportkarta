import { describe, expect, it } from 'vitest';

import { GRANT_REPORT } from './grant.js';
import { dayRangePeriod, previousQuarter, quarterOf, quarterPeriod } from './period.js';
import { QUARTERLY_REPORT } from './quarterly.js';
import { QUARTERLY_REPORT as QUARTERLY_AGAIN } from './quarterly.js';
import {
  isSuppressed,
  renderReportCsv,
  renderReportHtml,
  reportFilename,
  type ReportData,
} from './render.js';
import {
  ALLOWED_PLACEHOLDERS,
  allMetrics,
  allTables,
  assertKnownPlaceholders,
  assertSafeReportSql,
  MIN_DISCLOSED,
  placeholdersIn,
  type ReportDefinition,
} from './schema.js';

/**
 * The report catalogue's own guarantees (Stage 6.2).
 *
 * The database half — that each figure equals an independently written query,
 * and that municipal figures sum to national ones — lives in
 * db/src/reports/reconcile.test.ts, because only a database can make it.
 */

const DEFINITIONS: ReportDefinition[] = [GRANT_REPORT, QUARTERLY_REPORT];

const METRIC_CASES = DEFINITIONS.flatMap((definition) =>
  allMetrics(definition).map(({ metric }) => ({
    label: `${definition.id}.${metric.id}`,
    definition,
    metric,
  })),
);

const TABLE_CASES = DEFINITIONS.flatMap((definition) =>
  allTables(definition).map(({ table }) => ({
    label: `${definition.id}.${table.id}`,
    definition,
    table,
  })),
);

describe('the report catalogue cannot pass vacuously', () => {
  it('has definitions, sections and metrics', () => {
    expect(DEFINITIONS.length).toBeGreaterThan(1);
    for (const definition of DEFINITIONS) {
      expect(definition.sections.length, `${definition.id} has no sections`).toBeGreaterThan(0);
    }
    expect(METRIC_CASES.length).toBeGreaterThan(15);
    expect(TABLE_CASES.length).toBeGreaterThan(0);
  });

  it('ids are unique within a definition', () => {
    for (const definition of DEFINITIONS) {
      const ids = [
        ...allMetrics(definition).map(({ metric }) => metric.id),
        ...allTables(definition).map(({ table }) => table.id),
      ];
      expect(new Set(ids).size, `${definition.id} has duplicate ids`).toBe(ids.length);
    }
  });
});

describe('every figure is traceable and safe', () => {
  it.each(METRIC_CASES)('$label — SQL is a safe constant', ({ metric }) => {
    expect(() => {
      assertSafeReportSql(metric.sql, metric.id);
    }).not.toThrow();
    expect(() => {
      assertKnownPlaceholders(metric.sql, metric.id);
    }).not.toThrow();
    // Every metric must produce a column the runner can read.
    expect(metric.sql).toContain('AS value');
  });

  it.each(TABLE_CASES)('$label — SQL is a safe constant', ({ table }) => {
    expect(() => {
      assertSafeReportSql(table.sql, table.id);
    }).not.toThrow();
    expect(() => {
      assertKnownPlaceholders(table.sql, table.id);
    }).not.toThrow();
    expect(table.columns.length).toBe(table.columnsBg.length);
  });

  it('rejects SQL that could chain a statement or hide a comment', () => {
    // Proves the guard bites, so a clean run above means "checked", not
    // "the checker returns nothing".
    expect(() => {
      assertSafeReportSql('SELECT 1; DROP TABLE users', 'x');
    }).toThrow();
    expect(() => {
      assertSafeReportSql('SELECT 1 -- comment', 'x');
    }).toThrow();
    expect(() => {
      assertKnownPlaceholders('SELECT :secret AS value', 'x');
    }).toThrow(/unknown placeholder/);
  });

  it('reads casts as casts, not as placeholders', () => {
    // The bug this guards against would make every `::int` in the catalogue
    // look like a parameter called `int` and fail the allowlist — breaking all
    // of the municipality-scoped metrics at once.
    expect(placeholdersIn('f.municipality_id::int = :municipality::int')).toEqual(['municipality']);
    expect(placeholdersIn('count(*)::int AS value')).toEqual([]);
  });

  it.each(METRIC_CASES)('$label — declares a Bulgarian label and a definition', ({ metric }) => {
    // The ММС annex field name. Non-empty, Cyrillic, and NOT an i18n key —
    // this document is Bulgarian whatever locale the admin exporting it uses.
    expect(metric.labelBg.trim().length).toBeGreaterThan(0);
    expect(metric.labelBg).toMatch(/[А-Яа-я]/);
    expect(metric.definitionBg.trim().length).toBeGreaterThan(10);
  });

  it('every placeholder the catalogue uses is one the runner binds', () => {
    for (const { metric } of METRIC_CASES) {
      for (const name of placeholdersIn(metric.sql)) {
        expect(ALLOWED_PLACEHOLDERS as readonly string[]).toContain(name);
      }
    }
  });
});

describe('non-additive figures are marked as such', () => {
  it.each(METRIC_CASES)('$label — a DISTINCT person count is never additive', ({ metric }) => {
    // The trap this prevents: a ministry sums twelve municipal annexes and
    // exceeds the national total, because one person played in two places.
    const countsDistinctPeople = /count\(DISTINCT\s+\w+\.(user_id|actor|actor_id)/i.test(
      metric.sql,
    );
    if (countsDistinctPeople) {
      expect(metric.additive, `${metric.id} counts distinct people but claims to be additive`).toBe(
        false,
      );
    }
  });

  it('the grant report has at least one of each, so the distinction is exercised', () => {
    const metrics = allMetrics(GRANT_REPORT).map(({ metric }) => metric);
    expect(metrics.some((m) => m.additive)).toBe(true);
    expect(metrics.some((m) => !m.additive)).toBe(true);
  });
});

describe('attendance is never reported as one number', () => {
  it('the grant annex reports the three check-in methods separately', () => {
    const ids = allMetrics(GRANT_REPORT).map(({ metric }) => metric.id);
    expect(ids).toEqual(
      expect.arrayContaining(['attendance_qr', 'attendance_organizer', 'attendance_self']),
    );
    // ...and no metric sums them, which would report as evidence a figure
    // migration 0014's CHECK exists to say is not evidence.
    for (const { metric } of allMetrics(GRANT_REPORT)) {
      const mentionsCheckins = metric.sql.includes('play_session_checkins');
      if (mentionsCheckins) {
        expect(metric.sql, `${metric.id} counts check-ins without filtering the method`).toMatch(
          /c\.method\s*=/,
        );
      }
    }
  });

  it('the verified figure names the QR method explicitly', () => {
    const qr = allMetrics(GRANT_REPORT).find(({ metric }) => metric.id === 'attendance_qr');
    expect(qr?.metric.sql).toContain("c.method = 'qr'");
  });
});

describe('audience decides suppression, and it is a property of the report', () => {
  it('the public quarterly report suppresses; the ministry annex does not', () => {
    expect(QUARTERLY_REPORT.suppressSmallCounts).toBe(true);
    expect(GRANT_REPORT.suppressSmallCounts).toBe(false);
  });

  it('suppresses a small person-derived figure only in the public report', () => {
    const publicMetric = allMetrics(QUARTERLY_REPORT).find(
      ({ metric }) => metric.personDerived,
    )?.metric;
    const annexMetric = allMetrics(GRANT_REPORT).find(({ metric }) => metric.personDerived)?.metric;
    if (!publicMetric || !annexMetric) throw new Error('catalogue changed shape');

    expect(isSuppressed(QUARTERLY_REPORT, publicMetric, 3)).toBe(true);
    expect(isSuppressed(GRANT_REPORT, annexMetric, 3)).toBe(false);
    expect(isSuppressed(QUARTERLY_REPORT, publicMetric, MIN_DISCLOSED)).toBe(false);
  });

  it('never suppresses zero', () => {
    // "Nobody did this" discloses nothing about anybody, and redacting it would
    // make a real absence look like a privacy redaction — a worse reading.
    const personDerived = allMetrics(QUARTERLY_REPORT).find(
      ({ metric: m }) => m.personDerived,
    )?.metric;
    if (!personDerived) throw new Error('catalogue changed shape');
    expect(isSuppressed(QUARTERLY_REPORT, personDerived, 0)).toBe(false);
  });

  it('never suppresses a figure about places', () => {
    const placeMetric = allMetrics(QUARTERLY_REPORT).find(
      ({ metric }) => !metric.personDerived,
    )?.metric;
    if (!placeMetric) throw new Error('catalogue changed shape');
    expect(isSuppressed(QUARTERLY_REPORT, placeMetric, 1)).toBe(false);
  });
});

describe('civil Sofia reporting periods', () => {
  it('a quarter begins at midnight in Sofia, not in UTC', () => {
    const q2 = quarterPeriod('2026-Q2');
    // 1 April 2026, 00:00 Sofia = 31 March 2026, 21:00 UTC (summer, UTC+3).
    expect(q2.from.toISOString()).toBe('2026-03-31T21:00:00.000Z');
    // 1 July 2026, 00:00 Sofia.
    expect(q2.to.toISOString()).toBe('2026-06-30T21:00:00.000Z');
  });

  it('a winter quarter uses the winter offset', () => {
    // 1 January 2026, 00:00 Sofia = 31 December 2025, 22:00 UTC (UTC+2).
    expect(quarterPeriod('2026-Q1').from.toISOString()).toBe('2025-12-31T22:00:00.000Z');
  });

  it('consecutive quarters meet exactly, so nothing is double-counted or dropped', () => {
    for (const year of [2025, 2026, 2027]) {
      for (let q = 1; q <= 3; q += 1) {
        const current = quarterPeriod(`${String(year)}-Q${String(q)}`);
        const next = quarterPeriod(`${String(year)}-Q${String(q + 1)}`);
        expect(current.to.getTime(), `${String(year)}-Q${String(q)} → Q${String(q + 1)}`).toBe(
          next.from.getTime(),
        );
      }
      const q4 = quarterPeriod(`${String(year)}-Q4`);
      expect(q4.to.getTime()).toBe(quarterPeriod(`${String(year + 1)}-Q1`).from.getTime());
    }
  });

  it('resolves the quarter an instant falls in, at the boundary', () => {
    expect(quarterOf(new Date('2026-06-30T20:59:59Z'))).toBe('2026-Q2');
    expect(quarterOf(new Date('2026-06-30T21:00:00Z'))).toBe('2026-Q3');
  });

  it('previousQuarter is what a quarter-close run reports on', () => {
    // Run just after Q3 opens; the report covers Q2.
    expect(previousQuarter(new Date('2026-07-01T05:00:00Z'))).toBe('2026-Q2');
    expect(previousQuarter(new Date('2026-01-02T05:00:00Z'))).toBe('2025-Q4');
  });

  it('an inclusive day range becomes an exclusive instant bound', () => {
    const period = dayRangePeriod('2026-04-01', '2026-06-30');
    expect(period.from.toISOString()).toBe('2026-03-31T21:00:00.000Z');
    // The last day is INCLUDED: the bound is the following midnight.
    expect(period.to.toISOString()).toBe('2026-06-30T21:00:00.000Z');
  });

  it('a single-day range covers that whole day', () => {
    const period = dayRangePeriod('2026-04-15', '2026-04-15');
    expect(period.to.getTime() - period.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('refuses a reversed or malformed range', () => {
    expect(() => dayRangePeriod('2026-06-30', '2026-04-01')).toThrow();
    expect(() => dayRangePeriod('30.06.2026', '2026-04-01')).toThrow();
    expect(() => quarterPeriod('2026-Q5')).toThrow();
  });
});

describe('rendering', () => {
  const data: ReportData = {
    scope: {
      from: '2026-03-31T21:00:00.000Z',
      to: '2026-06-30T21:00:00.000Z',
      municipalityNameBg: 'Столична',
      generatedAt: '2026-07-23T08:00:00.000Z',
    },
    metrics: allMetrics(GRANT_REPORT).map(({ metric }, index) => ({
      metricId: metric.id,
      value: index === 0 ? null : index * 3,
    })),
    tables: [],
  };

  it('prints an INCLUSIVE period, though the bound is exclusive', () => {
    // The off-by-one this prevents lands in a document somebody signs: a
    // quarter labelled "01.04 – 01.07" reads as three months and a day.
    const html = renderReportHtml(GRANT_REPORT, data);
    expect(html).toContain('01.04.2026 – 30.06.2026');
    expect(html).not.toContain('01.07.2026');
  });

  it('prints every metric definition and its SQL in the methodology', () => {
    const html = renderReportHtml(GRANT_REPORT, data);
    for (const { metric } of allMetrics(GRANT_REPORT)) {
      expect(html, `${metric.id} label missing`).toContain(metric.labelBg);
      // The SQL is escaped in the output, so check a distinctive fragment.
      expect(html, `${metric.id} SQL missing`).toContain('play_session_occurrences');
    }
    expect(html).toContain('Методология');
  });

  it('is self-contained: no script, no external request', () => {
    const html = renderReportHtml(QUARTERLY_REPORT, {
      ...data,
      scope: { ...data.scope, municipalityNameBg: null },
      metrics: [],
      tables: [],
    });
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).toContain('@page');
  });

  it('renders a missing figure as an em dash, never as zero', () => {
    const html = renderReportHtml(GRANT_REPORT, data);
    expect(html).toContain('—');
  });

  it('marks non-additive figures in a municipality-scoped report', () => {
    const html = renderReportHtml(GRANT_REPORT, data);
    expect(html).toContain('не се сумира между общини');
  });

  it('omits the marker in a national-only report, where nothing is summable', () => {
    // Caught on the first real PDF: four figures on a national page carried a
    // warning about summing municipal annexes that do not exist. A marker
    // printed where it cannot apply teaches the reader to ignore it in the
    // document where it prevents a real error.
    const html = renderReportHtml(QUARTERLY_REPORT, {
      ...data,
      scope: { ...data.scope, municipalityNameBg: null },
      metrics: allMetrics(QUARTERLY_REPORT).map(({ metric }) => ({
        metricId: metric.id,
        value: 7,
      })),
    });
    expect(html).not.toContain('не се сумира между общини');
    expect(QUARTERLY_REPORT.municipalityScoped).toBe(false);
    expect(GRANT_REPORT.municipalityScoped).toBe(true);
  });

  it('escapes municipality names rather than interpolating them', () => {
    const html = renderReportHtml(GRANT_REPORT, {
      ...data,
      scope: { ...data.scope, municipalityNameBg: '<script>alert(1)</script>' },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('CSV carries the scope on every row, and a BOM for Excel', () => {
    const csv = renderReportCsv(GRANT_REPORT, data);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .filter(Boolean);
    const header = lines[0]?.split(',') ?? [];
    expect(header.slice(0, 3)).toEqual(['Период от', 'Период до', 'Обхват']);
    // Every data row repeats the period: an annex that cannot say what period
    // it covers is unfileable, and a CSV cannot carry a header block.
    for (const line of lines.slice(1)) {
      expect(line.startsWith('01.04.2026,30.06.2026,Столична')).toBe(true);
    }
    expect(lines.length - 1).toBe(allMetrics(GRANT_REPORT).length);
  });

  it('names the file after the report, the scope and the inclusive period', () => {
    expect(reportFilename(GRANT_REPORT, data.scope)).toBe(
      'otchet-grant-obshtina-2026-04-01_2026-06-30',
    );
  });

  it('renders identically however many times it is called', () => {
    // No hidden clock: everything time-dependent comes from `scope`.
    expect(renderReportHtml(QUARTERLY_AGAIN, { ...data, metrics: [], tables: [] })).toBe(
      renderReportHtml(QUARTERLY_REPORT, { ...data, metrics: [], tables: [] }),
    );
  });
});
