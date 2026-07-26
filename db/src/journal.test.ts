import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE MIGRATION JOURNAL IS A GATE, NOT A LOG — and this test is the only thing
 * that makes it one.
 *
 * drizzle's migrator applies a file if and only if its journal `when` exceeds the
 * newest `created_at` already recorded in `drizzle.__drizzle_migrations`. It never
 * looks at file order, at the array order, or at hashes. So a migration whose
 * `when` is LOWER than an already-applied one is **silently skipped**: exit code
 * 0, a green deploy, and a production database missing the schema its application
 * commit assumes.
 *
 * THIS HAS ALREADY HAPPENED ONCE. `0019_partners` was hand-stamped with a
 * timestamp ahead of the wall clock, so `0020_minors_as_adults` — generated hours
 * later by real clock time — got a lower stamp and did nothing on any database
 * that already had 0019. It was caught by chance, by a test that failed for a
 * different reason.
 *
 * It is self-concealing twice over, which is why a mechanical check is worth more
 * than the warnings in three migration headers: CI and `pnpm db:reset` build from
 * an EMPTY database, where the array order applies every file and everything is
 * green; and the skipped migration's snapshot already reflects its change, so no
 * future `drizzle-kit generate` will ever re-emit it.
 *
 * Pure file test: no database, so it runs everywhere the suite does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function journal(): JournalEntry[] {
  const raw = readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

describe('migration journal', () => {
  it('is not empty — a suite that iterates nothing is green and worthless', () => {
    expect(journal().length).toBeGreaterThan(20);
  });

  it('has STRICTLY INCREASING `when` stamps, or a migration is silently skipped', () => {
    const entries = journal();
    for (let i = 1; i < entries.length; i += 1) {
      const previous = entries[i - 1] as JournalEntry;
      const current = entries[i] as JournalEntry;
      expect(
        current.when,
        `${current.tag} (when=${current.when}) is not ahead of ${previous.tag} (when=${previous.when}) — ` +
          `drizzle would SKIP it on any database that already has ${previous.tag}. ` +
          `Hand-stamp the newer entry in db/migrations/meta/_journal.json.`,
      ).toBeGreaterThan(previous.when);
    }
  });

  it('numbers entries consecutively from zero, matching the file prefixes', () => {
    const entries = journal();
    entries.forEach((entry, i) => {
      expect(entry.idx, `entry ${i} has idx ${entry.idx}`).toBe(i);
      expect(entry.tag.startsWith(String(i).padStart(4, '0')), `tag ${entry.tag} vs idx ${i}`).toBe(
        true,
      );
    });
  });

  it('names a file that exists for every entry, and has an entry for every file', () => {
    const tags = journal().map((entry) => entry.tag);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.replace(/\.sql$/, ''))
      .sort();
    // Both directions: an entry with no file breaks `migrate`, and a file with no
    // entry is a migration that will never run — the quieter of the two failures.
    expect([...tags].sort()).toEqual(files);
  });
});
