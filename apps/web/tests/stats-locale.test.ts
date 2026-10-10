import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * /statistika, /obshtina/<city>, /danni and the municipality widget — the pages
 * a ministry, a journalist or a mayor's office quotes from. The UX audit
 * (2026-10-10, M-12/M-13) found them printing JavaScript's numbers on the
 * Bulgarian site («98.8%», «2.5 MB», «12.46»), chart labels drawn at ~7.7px on a
 * phone, a «next stage» promise for an open-data portal that had been live for
 * weeks, and «1-о място».
 */

const WEB = path.join(__dirname, '..');
const read = (...parts: string[]) => readFileSync(path.join(WEB, ...parts), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SURFACES = {
  statistika: read('app', '[locale]', 'statistika', 'page.tsx'),
  statsTable: read('components', 'stats', 'stats-table.tsx'),
  obshtina: read('app', '[locale]', 'obshtina', '[city]', 'page.tsx'),
  danni: read('app', '[locale]', 'danni', 'page.tsx'),
};

describe('figures are printed in the reader’s locale', () => {
  it.each(Object.entries(SURFACES))('%s formats no number or date by hand', (_, src) => {
    const body = code(src);
    expect(body).not.toMatch(/\.toFixed\(/);
    expect(body).not.toMatch(/new Intl\.(DateTimeFormat|NumberFormat)\(/);
  });

  it('the widget uses toFixed only for its CSS', () => {
    const uses = code(read('lib', 'widget.ts')).match(/^.*\.toFixed\(.*$/gm) ?? [];
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/const pct = /);
  });
});

describe('the bar charts are text, not a scaled picture', () => {
  const chart = code(read('components', 'stats', 'bar-chart.tsx'));

  it('draws no SVG text that would shrink with the viewport', () => {
    expect(chart).not.toMatch(/<svg|<text|fontSize/);
  });

  it('keeps its labels and values on the type scale', () => {
    expect(chart).toMatch(/text-caption/);
    expect(chart).not.toMatch(/text-\[/);
  });
});

describe('statistics copy', () => {
  const tBg = createTranslator({ locale: 'bg', messages: bg, namespace: 'Stats' });
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'Stats' });

  it('points to the open-data portal instead of promising it', () => {
    // String chunks come back joined: the link is the bracketed part.
    const link = (chunks: ReactNode) => `[${String(chunks)}]`;
    expect(tBg.rich('downloadOpenData', { link })).toBe(
      'Всички данни са свободни за изтегляне (CSV/GeoJSON) и през API — вижте [„Отворени данни“].',
    );
    expect(tEn.rich('downloadOpenData', { link })).toMatch(/— see \[Open data\]\.$/);
    expect(JSON.stringify(bg.Stats)).not.toMatch(/следващ етап/);
    expect(SURFACES.statistika).toMatch(/href="\/danni"/);
  });

  it('names «н/д» the way the table prints it', () => {
    expect(bg.Stats.na).toBe('н/д');
    expect(JSON.stringify(bg.Stats)).not.toMatch(/n\/a/);
  });
});

describe('counted copy agrees with its number', () => {
  const tA = createTranslator({ locale: 'bg', messages: bg, namespace: 'Accountability' });
  const tO = createTranslator({ locale: 'bg', messages: bg, namespace: 'OpenData' });
  const tOEn = createTranslator({ locale: 'en', messages: en, namespace: 'OpenData' });

  it('a rank needs no ordinal suffix to be right for 1, 2 and 3', () => {
    expect(tA('rankOf', { rank: 1, of: 265 })).toBe('място 1 от 265 общини');
    expect(tA('rankOf', { rank: 2, of: 265 })).toBe('място 2 от 265 общини');
    expect(JSON.stringify(en.Accountability.rankOf)).not.toMatch(/\{rank\}(st|nd|rd|th)/);
  });

  it('days and rows take the counted form', () => {
    expect(tA('daysCount', { count: 1 })).toBe('1 ден');
    expect(tA('daysCount', { count: 19 })).toBe('19 дни');
    expect(tO('dumpsRows', { count: 1 })).toBe('1 ред');
    expect(tO('dumpsRows', { count: 6912 })).toBe('6912 реда');
    // Grouped with a no-break space, so «12 345» never wraps across two lines.
    expect(tO('dumpsRows', { count: 12345 })).toBe('12\u00a0345 реда');
    expect(tOEn('dumpsRows', { count: 12345 })).toBe('12,345 rows');
  });
});
