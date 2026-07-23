/**
 * The report catalogue (docs/ROADMAP.md §8, Stage 6.2).
 *
 * A FIGURE IS A DECLARED METRIC, the same shape 6.1 gave exports and for the
 * same reason: the admin annex, the PDF renderer, the printed methodology and
 * the reconciliation tests all read one array, so a number cannot reach a
 * ministry without its definition, its SQL and its test coming with it. A
 * report assembled by hand is accurate the quarter it is written and quietly
 * wrong the next — and the wrongness surfaces in a room where somebody is
 * deciding whether to fund us.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO MAKE STRUCTURAL:
 *
 *  1. EVERY FIGURE IS TRACEABLE. `sql` is printed verbatim in the methodology
 *     section of every rendered report. "Where does 1 284 come from?" is
 *     answerable by re-running the query beside the number, by somebody who
 *     does not have our source code.
 *
 *  2. NON-ADDITIVE FIGURES SAY SO. A person who plays in Sofia and in Plovdiv
 *     is one participant nationally and appears in two municipal annexes. Sum
 *     the annexes and you exceed the national total; the ministry notices, and
 *     the answer is embarrassing. `additive: false` marks every distinct-person
 *     metric, the renderer marks it in the output, and the reconciliation test
 *     asserts that additive metrics DO sum and that non-additive ones are never
 *     presented as though they could.
 *
 *  3. ATTENDANCE IS NEVER ONE NUMBER. Stage 5.4 shipped a CHECK constraint
 *     saying that only a QR check-in is evidence — `self` is a button somebody
 *     tapped and `organizer` is somebody vouching. Reporting the three summed
 *     as "attendance" to a funder claims a figure our own schema refuses to
 *     treat as evidence. So the catalogue has no such metric: it has three,
 *     labelled, with the verified one first.
 *
 * ON THE BULGARIAN LABELS, AND WHY THEY ARE NOT IN messages/bg.json. An ММС
 * annex field name is a DOCUMENT FORMAT the ministry specifies, not UI copy. It
 * must read identically when an English-locale admin exports it, because the
 * artifact is a Bulgarian document filed with a Bulgarian authority — putting
 * it in the i18n catalogue would make it locale-dependent and therefore wrong
 * exactly once: the day somebody exports in English and files an annex that
 * gets rejected. Keeping them here also leaves
 * apps/web/tests/i18n-hardcoded.test.ts's allowlist empty, which is the point
 * of having that gate at all.
 *
 * Pure and dependency-free: imported by the web app, by a script, and by tests.
 */

export type MetricUnit = 'count' | 'percent' | 'per10k' | 'days';

/**
 * Named placeholders a metric's SQL may use. The compiler in
 * db/src/reports/run.ts binds them as parameters and rejects any other `:name`,
 * so a metric cannot reach for a value the scope does not define.
 *
 *   :from          inclusive start instant of the reporting window
 *   :to            EXCLUSIVE end instant — see reportWindow()
 *   :municipality  integer municipality id, or NULL for the national scope
 */
export const ALLOWED_PLACEHOLDERS = ['from', 'to', 'municipality'] as const;
export type Placeholder = (typeof ALLOWED_PLACEHOLDERS)[number];

export interface ReportMetric {
  /** Stable id. Appears in the CSV's machine column and in test names. */
  readonly id: string;
  /** The ММС annex field name. Bulgarian, always, whatever the UI locale. */
  readonly labelBg: string;
  /** One sentence saying what the number counts. Printed in the methodology. */
  readonly definitionBg: string;
  readonly unit: MetricUnit;
  /** Must produce exactly one row with one column named `value`. */
  readonly sql: string;
  /**
   * True when municipal figures for this metric may be summed to the national
   * one. False for anything counting DISTINCT PEOPLE.
   */
  readonly additive: boolean;
  /**
   * True when the figure is derived from people rather than from places. Public
   * reports k-suppress these below MIN_DISCLOSED; the admin annex does not (see
   * the note on audiences below).
   */
  readonly personDerived: boolean;
}

/**
 * A table block — coverage gaps, top-improving municipalities. Same traceability
 * rules as a metric; the SQL is printed and the columns are declared.
 */
export interface ReportTable {
  readonly id: string;
  readonly titleBg: string;
  readonly definitionBg: string;
  /** Column headers, in order. Bulgarian, for the same reason as labelBg. */
  readonly columnsBg: readonly string[];
  /** Result column names, in the order they map onto columnsBg. */
  readonly columns: readonly string[];
  readonly sql: string;
  readonly personDerived: boolean;
}

export interface ReportSection {
  readonly id: string;
  readonly titleBg: string;
  readonly metrics?: readonly ReportMetric[];
  readonly tables?: readonly ReportTable[];
}

export interface ReportDefinition {
  readonly id: string;
  readonly titleBg: string;
  /** Standing note printed under the title — what this document is and is not. */
  readonly preambleBg: string;
  /**
   * PUBLIC reports k-suppress person-derived figures; the admin annex does not.
   *
   * The asymmetry is deliberate and is the whole reason this is a property of
   * the REPORT rather than of the metric. A grant annex goes to a named
   * authority under a lawful basis and has to total correctly — an annex that
   * hides a count of 3 is not usable for accounting, and the ministry would
   * simply ask for it again. A public quarterly report is read by anyone, where
   * "1 person maintains this municipality's data" next to a municipality name
   * is close enough to a name. Same numbers, different audience, different
   * rule, and which rule applies is decided by which definition a metric is
   * listed in rather than by whoever writes the page that renders it.
   */
  readonly suppressSmallCounts: boolean;
  /**
   * Whether this report is ever produced per municipality.
   *
   * Decides whether the `additive` flag is SHOWN, not whether it is true. The
   * marker exists for one reader: somebody holding twelve municipal annexes,
   * about to add up a column. A national report has no municipal variant, so
   * printing "(не се сумира между общини)" beside every percentage there is
   * noise that trains the reader to ignore the marker in the document where it
   * actually prevents an error. Seen on the first real PDF, where four figures
   * on a national page carried a warning about summing municipalities.
   */
  readonly municipalityScoped: boolean;
  readonly sections: readonly ReportSection[];
}

/**
 * Below this, a person-derived figure in a PUBLIC report is withheld. Matches
 * apps/web/lib/accountability.ts's MIN_DISCLOSED_CONTRIBUTORS deliberately:
 * two different thresholds for the same kind of disclosure would mean one of
 * them is wrong.
 */
export const MIN_DISCLOSED = 5;

/** Rendered in place of a suppressed figure. */
export const SUPPRESSED_LABEL = 'под 5';

/**
 * Characters a catalogue SQL fragment may contain.
 *
 * These are compile-time constants — no request value reaches them; the scope
 * travels as bound parameters. This is not defence against an attacker but
 * against a future edit pasting something clever into a string that is later
 * handed to the driver. Colons are allowed because placeholders use them; `::`
 * casts are common in these queries and are covered by the same allowance.
 */
const FRAGMENT_ALLOWED = /^[A-Za-z0-9_.,()'"*+\-/<>=!:|\s%]+$/;

export function assertSafeReportSql(sql: string, where: string): void {
  if (!FRAGMENT_ALLOWED.test(sql)) {
    throw new Error(`reports: unsafe characters in SQL (${where})`);
  }
  if (sql.includes(';')) throw new Error(`reports: statement separator in SQL (${where})`);
  if (sql.includes('--')) throw new Error(`reports: line comment in SQL (${where})`);
  if (sql.includes('/*')) throw new Error(`reports: block comment in SQL (${where})`);
}

/**
 * The `:name` placeholders a fragment uses. `::type` casts are NOT placeholders
 * — the negative lookbehind is what keeps `municipality_id::int` from being
 * read as a placeholder called `int`, which would then fail the allowlist and
 * make every cast in the catalogue unusable.
 */
export function placeholdersIn(sql: string): string[] {
  const found = new Set<string>();
  for (const match of sql.matchAll(/(?<![:\w]):([a-z_]+)/g)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found];
}

export function assertKnownPlaceholders(sql: string, where: string): void {
  for (const name of placeholdersIn(sql)) {
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new Error(`reports: unknown placeholder ":${name}" (${where})`);
    }
  }
}

/** Every metric in a definition, flattened, tagged with its section. */
export function allMetrics(
  definition: ReportDefinition,
): { section: ReportSection; metric: ReportMetric }[] {
  return definition.sections.flatMap((section) =>
    (section.metrics ?? []).map((metric) => ({ section, metric })),
  );
}

/** Every table block in a definition, flattened. */
export function allTables(
  definition: ReportDefinition,
): { section: ReportSection; table: ReportTable }[] {
  return definition.sections.flatMap((section) =>
    (section.tables ?? []).map((table) => ({ section, table })),
  );
}
