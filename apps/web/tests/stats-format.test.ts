import { describe, expect, it } from 'vitest';

import { pct } from '../lib/stats-format';

describe('pct', () => {
  it('computes a one-decimal percentage', () => {
    expect(pct(5971, 6587)).toBe(90.6);
    expect(pct(1, 4)).toBe(25);
  });

  it('returns null (→ n/a) when the denominator is 0 — never interpolated', () => {
    expect(pct(0, 0)).toBeNull();
    expect(pct(5, 0)).toBeNull();
  });

  it('handles the extremes', () => {
    expect(pct(0, 10)).toBe(0);
    expect(pct(10, 10)).toBe(100);
  });
});
