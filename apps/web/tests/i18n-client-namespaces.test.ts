import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLIENT_SCOPES,
  type ClientScope,
  pickClientMessages,
  ROOT_CLIENT_NAMESPACES,
} from '../i18n/client-messages';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The browser gets only the message namespaces its client components read
 * (pre-launch audit, findings 121 and 164) — and never fewer.
 *
 * Fewer is the dangerous direction: a client component whose namespace is not
 * in its provider renders raw keys ("Checkin.title") instead of text, and only
 * on the page that uses it. So this test does not trust a hand-kept list. It
 * walks the REAL import graph from every route file, down through each
 * `'use client'` boundary and everything that boundary imports (all of which is
 * then browser code), collects each `useTranslations('…')` it meets, and checks
 * the result against the provider that wraps that route: the root set, or the
 * root set plus the route's CLIENT_SCOPES entry.
 *
 * It also fails in the other direction — a namespace listed but read by no
 * client component — so the lists cannot quietly grow back into the catalogue.
 */

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web
const APP_DIR = path.join(WEB_ROOT, 'app');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const sources = new Map<string, string>();
function source(file: string): string {
  let text = sources.get(file);
  if (text === undefined) {
    text = readFileSync(file, 'utf8');
    sources.set(file, text);
  }
  return text;
}

function isClientBoundary(file: string): boolean {
  return /^\s*['"]use client['"]/m.test(source(file));
}

/** Local imports only: the app's own files (relative or `@/`). Packages are not
 *  walked — none of the workspace packages calls next-intl. */
function localImports(file: string): string[] {
  const text = source(file);
  const specifiers = [
    // Type-only imports carry no runtime code, so they cannot render anything.
    ...[
      ...text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^'";]*?from\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]),
    // next/dynamic and other lazy imports.
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  const resolved: string[] = [];
  for (const specifier of specifiers) {
    if (!specifier) continue;
    let base: string;
    if (specifier.startsWith('@/')) base = path.join(WEB_ROOT, specifier.slice(2));
    else if (specifier.startsWith('.')) base = path.resolve(path.dirname(file), specifier);
    else continue;
    const hit = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
    ].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    if (hit) resolved.push(hit);
  }
  return resolved;
}

function namespacesIn(file: string): string[] {
  return [...source(file).matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (m) => m[1]?.split('.')[0] ?? '',
  );
}

/** Every namespace read by browser code reachable from `entries`, with who reads it. */
function clientNamespacesFrom(entries: string[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const stack = entries.map((file) => ({ file, client: false }));
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const client = next.client || isClientBoundary(next.file);
    const key = `${client ? 'c' : 's'}:${next.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (client) {
      for (const namespace of namespacesIn(next.file)) {
        if (!found.has(namespace)) found.set(namespace, new Set());
        found.get(namespace)?.add(path.relative(WEB_ROOT, next.file));
      }
    }
    for (const file of localImports(next.file)) stack.push({ file, client });
  }
  return found;
}

const scopes = Object.entries(CLIENT_SCOPES) as [
  ClientScope,
  (typeof CLIENT_SCOPES)[ClientScope],
][];
const scopeDir = (scope: ClientScope) => path.join(WEB_ROOT, CLIENT_SCOPES[scope].dir);

// Every file under app/ belongs to the innermost scope whose directory holds
// it, or to the root provider. A scope's OWN layout.tsx is the exception: it is
// what opens the scoped provider, so whatever it renders beside `children`
// (the admin header, say) still sits under the parent's.
const appFiles = walk(APP_DIR);
const ownedBy = (file: string): ClientScope | 'root' => {
  const match = scopes
    .filter(([scope]) => file.startsWith(scopeDir(scope) + path.sep))
    .filter(([scope]) => file !== path.join(scopeDir(scope), 'layout.tsx'))
    .sort(([a], [b]) => scopeDir(b).length - scopeDir(a).length)[0];
  return match ? match[0] : 'root';
};
const rootUse = clientNamespacesFrom(appFiles.filter((file) => ownedBy(file) === 'root'));
const scopeUse = new Map(
  scopes.map(([scope]) => [
    scope,
    clientNamespacesFrom(appFiles.filter((file) => ownedBy(file) === scope)),
  ]),
);

function describeUse(use: Map<string, Set<string>>, missing: string[]): string {
  return missing.map((ns) => `${ns} (read by ${[...(use.get(ns) ?? [])].join(', ')})`).join('; ');
}

describe('client message namespaces', () => {
  it('sees the client components it is meant to police', () => {
    // A broken walk would find nothing and pass everything.
    expect(rootUse.has('Map')).toBe(true);
    expect(rootUse.has('Footer')).toBe(true);
    expect(scopeUse.get('admin')?.has('AdminCampaigns')).toBe(true);
  });

  it('sends every page what the client components outside a scope read', () => {
    const missing = [...rootUse.keys()].filter(
      (ns) => !(ROOT_CLIENT_NAMESPACES as readonly string[]).includes(ns),
    );
    expect(missing, describeUse(rootUse, missing)).toEqual([]);
  });

  it.each(scopes)('sends %s routes what their client components read', (scope, config) => {
    const use = scopeUse.get(scope) ?? new Map<string, Set<string>>();
    const sent = new Set<string>([...ROOT_CLIENT_NAMESPACES, ...config.namespaces]);
    const missing = [...use.keys()].filter((ns) => !sent.has(ns));
    expect(missing, describeUse(use, missing)).toEqual([]);
  });

  it('lists nothing in the root set that no root client component reads', () => {
    expect(ROOT_CLIENT_NAMESPACES.filter((ns) => !rootUse.has(ns))).toEqual([]);
  });

  it.each(scopes)(
    'lists nothing for %s that its client components do not read',
    (scope, config) => {
      const use = scopeUse.get(scope);
      expect(config.namespaces.filter((ns) => !use?.has(ns))).toEqual([]);
      // Already sent by the root provider — listing it again only hides drift.
      expect(
        config.namespaces.filter((ns) =>
          (ROOT_CLIENT_NAMESPACES as readonly string[]).includes(ns),
        ),
      ).toEqual([]);
    },
  );

  it.each(scopes)('wraps the %s routes in a provider for that scope', (scope, config) => {
    const layout = path.join(WEB_ROOT, config.dir, 'layout.tsx');
    expect(existsSync(layout), `${config.dir}/layout.tsx`).toBe(true);
    const text = source(layout);
    expect(
      text.includes(`scopedMessagesLayout('${scope}')`) || text.includes(`scope="${scope}"`),
      `${config.dir}/layout.tsx does not provide scope '${scope}'`,
    ).toBe(true);
  });

  it('never hands the whole catalogue to the browser', () => {
    // A bare provider (no `messages`) falls back to every namespace; the one
    // sanctioned provider is i18n/client-intl-provider.tsx.
    const bare = appFiles.filter((file) => /<NextIntlClientProvider\b/.test(source(file)));
    expect(bare.map((file) => path.relative(WEB_ROOT, file))).toEqual([]);
    expect(source(path.join(APP_DIR, '[locale]', 'layout.tsx'))).toMatch(/<ClientIntlProvider\b/);
  });

  it('names only namespaces that exist in both catalogues', () => {
    const all = [...ROOT_CLIENT_NAMESPACES, ...scopes.flatMap(([, config]) => config.namespaces)];
    for (const ns of all) {
      expect(bg, ns).toHaveProperty([ns]);
      expect(en, ns).toHaveProperty([ns]);
    }
  });

  it('sends a small fraction of the catalogue, and nothing from the admin or mail copy', () => {
    const picked = pickClientMessages(bg as Record<string, unknown>);
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(size(picked)).toBeLessThan(size(bg) / 5);
    for (const ns of Object.keys(picked)) expect(ns).not.toMatch(/^Admin|Email$|^DevMail$/);
    // A scope adds to the root set rather than replacing it: a nested provider
    // REPLACES its parent's messages, so it must repeat them.
    const admin = pickClientMessages(bg as Record<string, unknown>, 'admin');
    for (const ns of ROOT_CLIENT_NAMESPACES) expect(admin).toHaveProperty([ns]);
    expect(admin).toHaveProperty(['AdminCampaigns']);
  });
});
