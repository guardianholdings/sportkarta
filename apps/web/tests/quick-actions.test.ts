import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';

/**
 * The navigation shell after the 2026-10-31 operator decisions (UX audit
 * N1–N3, N5): four tabs — Карта · Тренировки · Паспорт · Профил — and a «+»
 * that opens three actions. The vitest environment has no DOM, so the menu's
 * behaviour is pinned at the source; e2e/quick-actions.spec.ts drives it.
 */

const read = (...p: string[]) => readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const quick = read('components', 'shell', 'quick-actions.tsx');
const nav = read('components', 'shell', 'app-nav.tsx');
const explorer = read('components', 'map', 'map-explorer.tsx');

describe('the tab bar', () => {
  it('is Карта · Тренировки · Паспорт · Профил', () => {
    // From the source: app-nav imports the locale-aware Link, which needs Next.
    const block = /export const NAV = \[([\s\S]*?)\] as const;/.exec(nav)?.[1] ?? '';
    const tabs = [...block.matchAll(/key: '(\w+)', href: '([^']+)'/g)].map((m) => ({
      key: m[1] as keyof typeof bg.Nav,
      href: m[2],
    }));
    expect(tabs.map((n) => n.href)).toEqual(['/karta', '/sesii', '/pasport', '/profil']);
    expect(tabs.map((n) => bg.Nav[n.key])).toEqual(['Карта', 'Тренировки', 'Паспорт', 'Профил']);
  });

  it('says «Вход», not «Профил», to a visitor without a session', () => {
    expect(bg.Nav.navSignIn).toBe('Вход');
    expect(nav).toMatch(/SIGN_IN = \{ key: 'navSignIn', href: '\/vhod'/);
  });

  it('puts the same «+» on the bar, the rail and the map', () => {
    expect(nav).toMatch(/<QuickActions\s+variant="tab"/);
    expect(nav).toMatch(/<QuickActions variant="rail"/);
    expect(explorer).toMatch(/<QuickActions variant="floating" fromMap/);
    // The map's bar also starts «Добави съоръжение» where the map looks.
    expect(explorer).toMatch(/<BottomNav[\s\S]*?fromMap\s*\/>/);
    // No bare link to /dobavi is left standing in for the menu.
    expect(nav).not.toContain('href="/dobavi"');
    expect(explorer).not.toMatch(/<Link\s+href="\/dobavi"/);
  });
});

describe('the «+» menu', () => {
  it('offers the three actions, in order', () => {
    // The first two are computed when the menu opens (from the map's view).
    const keys = [...quick.matchAll(/\{ key: '(\w+)', href: ([^,]+), icon/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(keys).toEqual([
      ['addFacility', 'hrefs.add'],
      ['logTraining', 'hrefs.log'],
      ['scanQr', "'/skenirai'"],
    ]);
    expect(quick).toContain("useState({ add: '/dobavi', log: '/trenirovki?nova=1' })");
    expect(bg.Nav.quick.addFacility.title).toBe('Добави съоръжение');
    expect(bg.Nav.quick.logTraining.title).toBe('Запиши тренировка');
    expect(bg.Nav.quick.scanQr.title).toBe('Сканирай QR за присъствие');
  });

  it('is a modal that Escape, the backdrop and its own button all close', () => {
    expect(quick).toContain('role="dialog"');
    expect(quick).toContain('aria-modal="true"');
    expect(quick).toContain('aria-expanded={open}');
    expect(quick).toMatch(/event\.key === 'Escape'[\s\S]*?setOpen\(false\)/);
    expect(quick).toMatch(/aria-hidden\s+onClick=\{\(\) => setOpen\(false\)\}/);
    expect(quick).toMatch(/aria-label=\{t\('quick\.close'\)\}/);
    // Focus goes back to the «+» when it closes.
    expect(quick).toMatch(/trigger\.focus\(\)/);
  });

  it('keeps every action at the touch floor', () => {
    expect(quick).toMatch(/className="flex min-h-14 items-center/);
  });
});
