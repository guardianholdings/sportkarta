import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A text that still waits on a decision ships with a literal gap marker,
 * `[G<n>]`: today the Google Analytics retention period in
 * Privacy.retention.googleAnalytics, until that period is chosen. This test
 * fails while any marker is left in messages/*.json, so a head that still has
 * an open gap cannot pass CI.
 */

const MESSAGES = join(__dirname, '..', 'messages');

type Tree = string | { [key: string]: Tree };

function openGaps(node: Tree, path: string): string[] {
  if (typeof node === 'string') return node.includes('[G') ? [path] : [];
  return Object.entries(node).flatMap(([key, child]) =>
    openGaps(child, path ? `${path}.${key}` : key),
  );
}

describe('the message catalogues', () => {
  it('carry no [G…] gap marker', () => {
    const open = readdirSync(MESSAGES)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) =>
        openGaps(JSON.parse(readFileSync(join(MESSAGES, file), 'utf8')) as Tree, '').map(
          (path) => `${file}: ${path}`,
        ),
      );
    expect(open).toEqual([]);
  });
});
