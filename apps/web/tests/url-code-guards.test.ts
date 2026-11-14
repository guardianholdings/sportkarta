import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { type AbstractIntlMessages, createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { isOutcomeCode } from '@/lib/clubs/form-error';

import bg from '../messages/bg.json';

/**
 * Pages splice `?rezultat=` / `?otmetka=` into a message key and ask
 * next-intl's `t.has` first. `has` walks `messages[part]` on plain objects, so
 * an inherited name resolves: `?rezultat=constructor` rendered the raw key
 * path and fired onError. These pin the guard against the REAL catalogue, and
 * keep every such lookup in app/ and components/ behind it — including the
 * ones written after this test.
 */

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];

describe('isOutcomeCode', () => {
  it('makes a crafted code miss the real catalogue like any unknown one', () => {
    // Untyped like the pages' own `t`, whose keys a URL code is spliced into.
    const messages: AbstractIntlMessages = bg;
    const t = createTranslator({ locale: 'bg', messages, namespace: 'ClubEvents' });
    const known = (code: string) => isOutcomeCode(code) && t.has(`public.outcome.${code}`);
    expect(known('registered')).toBe(true);
    for (const code of [...INHERITED, 'nope', '', 'a.b']) expect(known(code)).toBe(false);
  });

  it('keeps a camelCase outcome such as readOnly', () => {
    expect(isOutcomeCode('readOnly')).toBe(true);
    expect(isOutcomeCode(undefined)).toBe(false);
  });
});

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web
const SCAN_DIRS = ['app', 'components'];

/**
 * `t.has` lookups whose key part is DATA, never the request — so they need no
 * guard. A new entry here is a claim that the value cannot come from a URL.
 */
const DATA_DRIVEN = new Set([
  'app/[locale]/admin/(protected)/facilities/[id]/page.tsx :: field', // facility_edits.field
  'app/[locale]/admin/(protected)/import/[jobId]/page.tsx :: job.state', // import job state
  'app/[locale]/admin/(protected)/import/page.tsx :: job.state',
  'app/[locale]/admin/(protected)/moderation/page.tsx :: reason', // moderation_flags.reason
  'app/[locale]/admin/(protected)/redakcii/page.tsx :: field', // facility_edits.field
  'app/[locale]/admin/(protected)/zdrave/page.tsx :: queueKey(name)', // pg-boss queue name
  'app/[locale]/klub/[slug]/(office)/prodazhbi/[saleId]/page.tsx :: method', // payment method
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('URL codes in message keys', () => {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(WEB_ROOT, dir))).map((file) => ({
    name: path.relative(WEB_ROOT, file),
    source: readFileSync(file, 'utf8'),
  }));

  it('guards every interpolated t.has that is not data-driven', () => {
    const unguarded: string[] = [];
    const seen = new Set<string>();
    for (const { name, source } of files) {
      for (const match of source.matchAll(/\.has\(`[^`$]*\$\{([^}]+)\}[^`]*`\)/g)) {
        const expr = match[1] ?? '';
        const site = `${name} :: ${expr}`;
        seen.add(site);
        if (DATA_DRIVEN.has(site)) continue;
        const before = source.slice(Math.max(0, match.index - 200), match.index + 1);
        const guard = `(?:isOutcomeCode|isPlainCode)\\(${escape(expr)}\\)\\s*&&\\s*\\w+\\.$`;
        if (!new RegExp(guard).test(before)) unguarded.push(site);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
    expect(unguarded).toEqual([]);
    // An allowlist entry that matches nothing is stale — remove it.
    expect([...DATA_DRIVEN].filter((site) => !seen.has(site))).toEqual([]);
  });

  it('reads a URL code out of a constant map by an own key only', () => {
    const unguarded: string[] = [];
    for (const { name, source } of files) {
      for (const match of source.matchAll(
        /\b([A-Z][A-Z_]*)\[((?:query\.)?(?:rezultat|otmetka))\]/g,
      )) {
        const [, map, expr] = match;
        if (!source.includes(`Object.hasOwn(${map}, ${expr})`)) {
          unguarded.push(`${name} :: ${map}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
  });
});
