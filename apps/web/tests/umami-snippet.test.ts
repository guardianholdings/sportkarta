import { describe, expect, it } from 'vitest';

import { UmamiAnalytics } from '@/components/analytics/umami';

/**
 * The analytics snippet must not report query strings (pre-launch audit,
 * legal cluster). The map keeps its centre in `?lat=…&lng=…`, which after
 * "locate me" is the visitor's own position to about a metre, and Umami's
 * tracker reports every history change — so without the flag the analytics
 * database would collect positions that /privacy says never leave the browser.
 */
describe('UmamiAnalytics', () => {
  it('excludes the query string from every tracked URL', () => {
    const element = UmamiAnalytics({ src: 'https://umami.pops.test/script.js', websiteId: 'w' });
    const props = element.props as Record<string, unknown>;
    expect(props['data-exclude-search']).toBe('true');
    expect(props['data-website-id']).toBe('w');
  });
});
