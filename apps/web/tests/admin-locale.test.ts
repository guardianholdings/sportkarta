import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The admin keeps its locale (UX audit 2026-10-10, A-14 and A-5).
 *
 * bg is served unprefixed and en under /en, so an unprefixed path is the
 * Bulgarian site: next/navigation's redirect('/admin/…') and a GET form posting
 * to "/admin/…" both dropped an /en admin onto bg mid-task. Redirects go
 * through '@/i18n/navigation' with the request's locale, and GET forms spell
 * the prefix out with getPathname.
 */

const ADMIN = path.join(process.cwd(), 'app', '[locale]', 'admin');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(ADMIN).map((file) => ({
  file: path.relative(ADMIN, file),
  source: readFileSync(file, 'utf8'),
}));

describe('admin redirects and forms keep the locale', () => {
  it('never redirect through next/navigation', () => {
    const offenders = files
      .filter(({ source }) =>
        /import\s*\{[^}]*\bredirect\b[^}]*\}\s*from\s*'next\/navigation'/.test(source),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('never point a form at an unprefixed path', () => {
    const offenders = files
      .filter(({ source }) => /<form[^>]*\saction="\//.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('take a renamed campaign to its new address (A-5)', () => {
    const actions = files.find(({ file }) => file.endsWith(path.join('kampanii', 'actions.ts')));
    expect(actions?.source).toMatch(
      /if \(nextSlug !== currentSlug\) \{\s*redirect\(\{ href: `\/admin\/kampanii\/\$\{nextSlug\}`/,
    );
    const page = files.find(({ file }) =>
      file.endsWith(path.join('kampanii', '[slug]', 'page.tsx')),
    );
    expect(page?.source).toMatch(/updateCampaignAction\.bind\(null, campaign\.slug\)/);
  });
});
