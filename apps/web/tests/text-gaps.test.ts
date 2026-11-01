import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A text that still waits on a decision ships with a literal gap marker:
 * `[G<n>]`, `[gap:…]` or `[cookie-…]` (the copywriter's three forms). This
 * test fails while any marker is left in messages/*.json, so a head that still
 * has an open gap cannot pass CI.
 */

const MESSAGES = join(__dirname, '..', 'messages');

const GAP_MARKER = /\[(G[0-9]|gap:|cookie-)/;

type Tree = string | { [key: string]: Tree };

function openGaps(node: Tree, path: string): string[] {
  if (typeof node === 'string') return GAP_MARKER.test(node) ? [path] : [];
  return Object.entries(node).flatMap(([key, child]) =>
    openGaps(child, path ? `${path}.${key}` : key),
  );
}

function catalogue(file: string): Tree {
  return JSON.parse(readFileSync(join(MESSAGES, file), 'utf8')) as Tree;
}

describe('the message catalogues', () => {
  it('carry no gap marker', () => {
    const open = readdirSync(MESSAGES)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => openGaps(catalogue(file), '').map((path) => `${file}: ${path}`));
    expect(open).toEqual([]);
  });

  it('would fail on a catalogue with one gap left in', () => {
    // The shipped bg catalogue with the cookie lifetime put back as a gap.
    const bg = catalogue('bg.json') as { Privacy: { cookies: { body: string } } };
    bg.Privacy.cookies.body = bg.Privacy.cookies.body.replace(
      /до 13\u00a0месеца/,
      'до [cookie-lifetime]',
    );
    expect(openGaps(bg as unknown as Tree, '')).toEqual(['Privacy.cookies.body']);
  });

  it('knows every form of marker, and nothing else', () => {
    for (const marker of ['[G3]', '[gap: retention]', '[cookie-lifetime]']) {
      expect(GAP_MARKER.test(`a ${marker} b`), marker).toBe(true);
    }
    for (const text of ['[Google]', '[gapless]', '[cookies]', 'G3', '_ga_XRJS0YRT3Q']) {
      expect(GAP_MARKER.test(text), text).toBe(false);
    }
  });
});
