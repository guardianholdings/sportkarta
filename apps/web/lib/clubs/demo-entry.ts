/**
 * The campaign tags (utm_*) an e-mail link to /klubove/demo carries: the same
 * keys as CAMPAIGN_PARAMS in components/analytics/umami.tsx. The entry
 * forwards them to the demo club's dashboard, so the visit's landing pageview
 * there still names the campaign. Nothing else in the address goes along.
 */
export const DEMO_ENTRY_TAGS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

/** The query the entry forwards: each tag's first non-empty value, nothing else. */
export function demoEntryQuery(
  searchParams: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of DEMO_ENTRY_TAGS) {
    const value = searchParams[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (first) query[key] = first;
  }
  return query;
}
