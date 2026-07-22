import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

/**
 * Render a query to the exact text and bound parameters the driver would send.
 *
 * Diagnostic/test helper: it is what lets a test assert that a given value —
 * for instance a date of birth — never reaches the database in any form, text
 * or parameter (apps/web/tests/dob-not-persisted.test.ts).
 */
export function renderSql(query: SQL): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(query);
  return { sql, params };
}
