import { describe, expect, it } from 'vitest';

import {
  discloseContributors,
  MIN_DISCLOSED_CONTRIBUTORS,
  NON_NUMERIC_FIELDS,
  type MunicipalityAccountability,
} from '../lib/accountability';
import { escapeHtml, renderWidget, type WidgetStrings } from '../lib/widget';

/**
 * Stage 3.4's binding rule is that the municipality widget is AGGREGATE ONLY.
 * It renders inside an iframe on somebody else's domain, where our privacy page
 * does not apply and where we would never see a leak, so the rule is enforced
 * on the SHAPE of the payload rather than on the judgement of whoever edits the
 * page next.
 *
 * The gate has two stages and both are needed:
 *
 *   1. `SAMPLE` is annotated `: MunicipalityAccountability`, so TypeScript
 *      forces every field of the interface to appear here. Adding
 *      `topContributor: string` to the interface breaks `pnpm typecheck` until
 *      somebody adds it to this fixture.
 *   2. Having been forced to add it, the test below then fails, because the
 *      field holds a string and is not one of NON_NUMERIC_FIELDS.
 *
 * Either stage alone would be bypassable; together, a personal-data field
 * cannot reach the widget without a deliberate edit to the allowlist, which is
 * exactly the decision that deserves a reviewer.
 */

const SAMPLE: MunicipalityAccountability = {
  nameBg: 'Столична',
  nameEn: 'Stolichna',
  slug: 'sofia',
  ekatteCode: 'SOF46',
  generatedAt: '2026-07-23T09:00:00.000Z',
  license: 'ODbL 1.0',

  population: 1_200_000,

  total: 1700,
  free: 1500,
  lit: 300,
  covered: 120,
  per10k: 14.2,
  per10kRank: 12,
  per10kOf: 265,

  active: 900,
  needsVerification: 800,
  withPhoto: 210,

  fromOsm: 1600,
  fromMunicipal: 40,
  fromCrowd: 60,

  conditionExcellent: 30,
  conditionGood: 90,
  conditionPoor: 40,
  conditionUnusable: 12,
  conditionUnreported: 1528,

  reportsOpen: 7,
  reportsOldestOpenDays: 19.4,
  reportsResolvedInWindow: 44,
  reportsMedianHours: 31.5,

  editsInWindow: 320,
  contributors: 18,
};

const STRINGS: WidgetStrings = {
  title: 'Free sports infrastructure',
  total: 'Facilities',
  per10k: 'Per 10,000 residents',
  freeShare: 'Share with free access',
  openReports: 'Open reports',
  medianResponse: 'Median time to decision',
  hours: 'h',
  days: 'days',
  na: 'no data',
  attribution: 'Data: SportKarta and OpenStreetMap, ODbL 1.0.',
  more: 'Full figures and methodology',
  conditionHeading: 'Condition',
  conditionExcellent: 'Excellent',
  conditionGood: 'Good',
  conditionPoor: 'Poor',
  conditionUnusable: 'Unusable',
  conditionUnreported: 'Not reported',
};

function widget(overrides: Partial<MunicipalityAccountability> = {}, cityName = 'София'): string {
  return renderWidget({
    data: { ...SAMPLE, ...overrides },
    cityName,
    pageUrl: 'https://sportkarta.bg/obshtina/sofia',
    locale: 'bg',
    strings: STRINGS,
  });
}

describe('accountability payload is aggregate-only', () => {
  const allowed = new Set<string>(NON_NUMERIC_FIELDS);

  it('every field outside the allowlist is a number or null', () => {
    const offenders = Object.entries(SAMPLE)
      .filter(([key]) => !allowed.has(key))
      .filter(([, value]) => value !== null && typeof value !== 'number')
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it('the allowlisted fields identify a PLACE, never a person', () => {
    // Named explicitly so widening the allowlist is a visible diff in a test
    // whose whole subject is the privacy rule, not a one-word edit in a const.
    expect([...NON_NUMERIC_FIELDS].sort()).toEqual([
      'ekatteCode',
      'generatedAt',
      'license',
      'nameBg',
      'nameEn',
      'slug',
    ]);
  });
});

describe('contributor counts are small-number suppressed', () => {
  it('discloses zero as zero — "nobody contributes here" is a finding', () => {
    expect(discloseContributors(0)).toBe(0);
  });

  it('suppresses every count below the threshold', () => {
    for (let n = 1; n < MIN_DISCLOSED_CONTRIBUTORS; n++) {
      expect(discloseContributors(n)).toBeNull();
    }
  });

  it('discloses the threshold and above', () => {
    expect(discloseContributors(MIN_DISCLOSED_CONTRIBUTORS)).toBe(MIN_DISCLOSED_CONTRIBUTORS);
    expect(discloseContributors(99)).toBe(99);
  });

  it('never leaks the exact suppressed count through the type', () => {
    // null carries no information beyond "below the threshold" — which is the
    // point of returning null rather than the count plus a flag.
    expect(discloseContributors(1)).toBe(discloseContributors(MIN_DISCLOSED_CONTRIBUTORS - 1));
  });
});

describe('escapeHtml', () => {
  it('escapes every character that can end an attribute or open a tag', () => {
    expect(escapeHtml(`<img src="x" onerror='y'>&`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;',
    );
  });

  it('leaves Cyrillic and ordinary text alone', () => {
    expect(escapeHtml('София — 1 700 обекта')).toBe('София — 1 700 обекта');
  });
});

describe('renderWidget', () => {
  it('contains no script tag and no javascript: URL', () => {
    const html = widget();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
    // No inline event handlers either — the CSP would block them, but the
    // document should not be relying on the header to be safe.
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('makes no external request — every asset is inline', () => {
    const html = widget();
    // The only absolute URL is the link back to our own page.
    const urls = html.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    expect(urls).toEqual(['https://sportkarta.bg/obshtina/sofia']);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
  });

  it('always carries ODbL attribution', () => {
    expect(widget()).toContain(STRINGS.attribution);
  });

  it('escapes the municipality name rather than trusting the database', () => {
    const html = widget({}, '<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders "no data" instead of inventing a figure', () => {
    const html = widget({ per10k: null, reportsMedianHours: null });
    expect(html).toContain(STRINGS.na);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('null');
  });

  it('reports a median of days once it passes two days, and hours below that', () => {
    expect(widget({ reportsMedianHours: 72 })).toContain(`3 ${STRINGS.days}`);
    expect(widget({ reportsMedianHours: 30 })).toContain(`30 ${STRINGS.hours}`);
  });

  it('omits the condition bar entirely when the municipality has no facilities', () => {
    const empty = widget({
      total: 0,
      free: 0,
      conditionExcellent: 0,
      conditionGood: 0,
      conditionPoor: 0,
      conditionUnusable: 0,
      conditionUnreported: 0,
    });
    // A zero-width bar would render as a grey sliver implying "all unreported".
    expect(empty).not.toContain('class="bar"');
    expect(empty).toContain('>0<');
  });

  it('spells the condition breakdown out for a screen reader', () => {
    // These five numbers appear nowhere else in the widget, so the bar's label
    // is the only way to read them without seeing colour.
    const html = widget({
      conditionExcellent: 3,
      conditionGood: 4,
      conditionPoor: 5,
      conditionUnusable: 6,
      conditionUnreported: 7,
    });
    expect(html).toContain(
      'aria-label="Condition: Excellent 3, Good 4, Poor 5, Unusable 6, Not reported 7"',
    );
  });

  it('divides the condition bar by share, not by count of segments', () => {
    const html = widget({
      conditionExcellent: 1,
      conditionGood: 1,
      conditionPoor: 1,
      conditionUnusable: 1,
      conditionUnreported: 96,
    });
    expect(html).toContain('flex:96.00 0 0');
    expect(html).toContain('flex:1.00 0 0');
  });
});
