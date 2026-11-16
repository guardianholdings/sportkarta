import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The admin nav on a phone (UX audit 2026-10-10 A-17, then 2026-10-31 V-27):
 * sixteen links wrapped into five rows above every screen; then one row that
 * scrolled sideways but never brought the current tab into view. Below `sm`
 * it is one ScrollStrip — scrolls, fades, centres the current tab — with
 * every link a 44px target; from `sm` the links wrap as before.
 */
describe('the admin nav', () => {
  const nav = readFileSync(path.join(process.cwd(), 'components/shell/admin-nav.tsx'), 'utf8');
  const layout = readFileSync(
    path.join(process.cwd(), 'app/[locale]/admin/(protected)/layout.tsx'),
    'utf8',
  );

  it('is one ScrollStrip that follows the pathname and wraps from sm', () => {
    expect(nav).toMatch(/<ScrollStrip[^>]*\bas="nav"/);
    expect(nav).toMatch(/activeKey=\{pathname\}/);
    expect(nav).toMatch(/wrapFrom="sm"/);
  });

  it('gives every link a 44px target on a phone', () => {
    expect(nav).toMatch(/\bmin-h-11\b/);
    expect(nav).toMatch(/\bwhitespace-nowrap\b/);
    expect(nav).toMatch(/\bshrink-0\b/);
  });

  it('leaves the layout without a scroll wrapper of its own', () => {
    expect(layout).not.toMatch(/overflow-x-auto/);
    expect(layout).toMatch(/<AdminNav[\s\S]*?label=\{t\('title'\)\}/);
  });
});
