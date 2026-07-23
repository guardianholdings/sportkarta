import { asQueryable, getDb, getPool, runReport, sql } from '@sportkarta/db';
import {
  dayRangePeriod,
  GRANT_REPORT,
  renderReportCsv,
  renderReportHtml,
  reportFilename,
  type ReportData,
} from '@sportkarta/lib/reports';

/**
 * The admin grant-report export (Stage 6.2). Server-only.
 *
 * Everything here is a thin shell around the catalogue: parse a scope the
 * operator typed, resolve the municipality's name, run the definition, render.
 * NO FIGURE IS COMPUTED IN THIS FILE, deliberately — the moment one were, it
 * would be a number with no printed definition, no SQL beside it and no
 * reconciliation test, in the one document where those matter most.
 *
 * The runner binds POSITIONAL parameters, because its SQL comes from a
 * catalogue rather than from a tagged template, so it takes the pg pool rather
 * than the drizzle handle. Same pool either way.
 */

export interface GrantScopeInput {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, INCLUSIVE as typed; converted to an exclusive bound. */
  to: string;
  /** Municipality id, or null for the national scope. */
  municipalityId: number | null;
}

export class ReportScopeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReportScopeError';
  }
}

/** Longest period the form accepts, so one click cannot scan a decade. */
export const MAX_PERIOD_DAYS = 800;

export function parseGrantScope(params: URLSearchParams): GrantScopeInput {
  const from = (params.get('from') ?? '').trim();
  const to = (params.get('to') ?? '').trim();
  const rawMunicipality = (params.get('municipality') ?? '').trim();

  if (!from || !to) throw new ReportScopeError('missingPeriod');

  let period;
  try {
    period = dayRangePeriod(from, to);
  } catch {
    // dayRangePeriod refuses a malformed or reversed range; both are the same
    // thing to the operator — "check the dates" — so they share one message.
    throw new ReportScopeError('invalidPeriod');
  }
  const days = (period.to.getTime() - period.from.getTime()) / 86_400_000;
  if (days > MAX_PERIOD_DAYS) throw new ReportScopeError('periodTooLong');

  let municipalityId: number | null = null;
  if (rawMunicipality && rawMunicipality !== 'all') {
    const parsed = Number(rawMunicipality);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new ReportScopeError('invalidMunicipality');
    municipalityId = parsed;
  }

  return { from, to, municipalityId };
}

async function municipalityName(municipalityId: number | null): Promise<string | null> {
  if (municipalityId === null) return null;
  const result = await getDb().execute(
    sql`SELECT name_bg FROM municipalities WHERE id = ${municipalityId}`,
  );
  const row = result.rows[0];
  // An unknown id is REFUSED rather than quietly treated as national scope: an
  // annex whose header says "Национален обхват" over one municipality's figures
  // is the kind of error nobody catches until after it is filed.
  if (!row) throw new ReportScopeError('invalidMunicipality');
  return String(row.name_bg);
}

export async function buildGrantReport(scope: GrantScopeInput): Promise<ReportData> {
  const period = dayRangePeriod(scope.from, scope.to);
  const name = await municipalityName(scope.municipalityId);
  return runReport(
    asQueryable(getPool()),
    GRANT_REPORT,
    { from: period.from, to: period.to, municipalityId: scope.municipalityId },
    name,
  );
}

export function grantCsv(data: ReportData): { body: string; filename: string } {
  return {
    body: renderReportCsv(GRANT_REPORT, data),
    filename: `${reportFilename(GRANT_REPORT, data.scope)}.csv`,
  };
}

export function grantHtml(data: ReportData): { body: string; filename: string } {
  return {
    body: renderReportHtml(GRANT_REPORT, data),
    filename: `${reportFilename(GRANT_REPORT, data.scope)}.html`,
  };
}
