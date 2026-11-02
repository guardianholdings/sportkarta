/** One figure of the front page's numbers band. */
export interface NumbersFigure {
  key: 'places' | 'municipalities' | 'games' | 'contributions';
  value: number;
}

/**
 * The front page's numbers band (components/marketing/numbers-band.tsx), in the
 * platform's own figures. A figure with no number is left out, and so is the
 * games figure while there are no games this week (operator, 2026-11-02): «0
 * игри тази седмица» on the front page reads as an empty platform. The clubs
 * page's audience band follows the same rule (lib/clubs/landing.ts).
 */
export function numbersFigures(
  places: number | null,
  municipalities: number | null,
  gamesThisWeek: number | null,
  contributions: number | null,
): NumbersFigure[] {
  const figures: NumbersFigure[] = [];
  if (places !== null) figures.push({ key: 'places', value: places });
  if (municipalities !== null) figures.push({ key: 'municipalities', value: municipalities });
  if (gamesThisWeek !== null && gamesThisWeek > 0) {
    figures.push({ key: 'games', value: gamesThisWeek });
  }
  if (contributions !== null) figures.push({ key: 'contributions', value: contributions });
  return figures;
}

/**
 * Whole class names, so Tailwind generates each one: on a wide screen the band
 * puts every figure in one row, and three figures leave no empty fourth column.
 */
const WIDE_COLUMNS: Readonly<Record<number, string>> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
};

/** The band's columns from `lg` up; below it the band stays two columns wide. */
export function numbersWideColumns(count: number): string {
  return WIDE_COLUMNS[count] ?? 'lg:grid-cols-4';
}
