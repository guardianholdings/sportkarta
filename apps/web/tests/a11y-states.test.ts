import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Accessibility details from the UX audit of 2026-10-10 (S-19), asserted at the
 * source level: each was invisible to anyone looking at a screenshot.
 */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('badge state is spoken, not only tinted', () => {
  it('names earned and locked inside the badge heading', () => {
    const grid = source('../components/passport/badge-grid.tsx');
    expect(grid).toMatch(
      /<span className="sr-only">\s*, \{badge\.earned \? t\('stateEarned'\) : t\('stateLocked'\)\}/,
    );
  });
});

describe('«Копирай текста» is a control', () => {
  it('is a button that copies, not a span dressed as one', () => {
    const share = source('../components/share/week-share.tsx');
    expect(share).toMatch(/<Button[\s\S]{0,200}copyText\('copy'\)[\s\S]{0,300}t\('copy'\)/);
    expect(share).not.toMatch(/<span className="text-caption text-text-muted">\s*<Copy/);
  });
});

describe('partner logos do not repeat the visible name', () => {
  it.each(['../components/campaigns/campaign-sponsor.tsx', '../app/[locale]/partnyori/page.tsx'])(
    '%s marks the logo decorative',
    (relative) => {
      // Comments stripped: the note beside the attribute quotes the old value.
      const file = source(relative).replace(/\/\/[^\n]*/g, '');
      const img = /<img[\s\S]*?\/>/.exec(file)?.[0] ?? '';
      expect(img).toContain('alt=""');
      expect(img).not.toContain('alt={name}');
    },
  );
});
