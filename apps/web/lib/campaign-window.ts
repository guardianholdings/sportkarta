/**
 * Human label for a campaign window ("1 – 31 август 2026 г."), replacing the
 * raw civil dates ("2026-08-01 → 2026-08-31") the pages used to print.
 * `endsOn` is inclusive by the campaign contract, and both bounds are civil
 * Sofia dates — parsed and formatted in UTC so they stay calendar dates.
 */
export function campaignWindowLabel(
  locale: string,
  window: { startsOn: string; endsOn: string },
): string {
  const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return format.formatRange(
    new Date(`${window.startsOn}T00:00:00Z`),
    new Date(`${window.endsOn}T00:00:00Z`),
  );
}
