import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { renderSql, type SQL } from '@sportkarta/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildProfileUpdate,
  PROFILE_PERSISTED_FIELDS,
  ProfileValidationError,
  saveProfile,
} from '@/lib/profile';

/**
 * The legal constant from docs/ROADMAP.md §0: "DOB derived-then-discarded".
 *
 * This suite is the proof. It runs the real profile-save path with a real date
 * of birth and asserts the date reaches neither the database nor any log, then
 * checks statically that no schema, migration or server action could reintroduce
 * it behind the test's back.
 */

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');

const DOB = '2012-03-14';
// Every rendering of that date a careless implementation might leak.
const DOB_FRAGMENTS = [DOB, '14/03/2012', '14.03.2012', '2012'];
// Fixed clock: the derived category must not depend on when the suite runs.
const NOW = new Date('2026-07-22T09:00:00Z');

/** Records every statement instead of talking to Postgres. */
function recordingDb() {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: [] });
    },
  };
}

function serialise(statements: { sql: string; params: unknown[] }[]): string {
  return statements.map((s) => `${s.sql} ${JSON.stringify(s.params)}`).join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the date of birth never reaches the database', () => {
  it('is absent from the statement text and from the bound parameters', async () => {
    const db = recordingDb();
    const update = buildProfileUpdate(
      {
        displayName: 'Ивайло',
        homeCity: 'Пловдив',
        dateOfBirth: DOB,
      },
      NOW,
    );
    await saveProfile(db, 'user_123', update);

    expect(db.statements).toHaveLength(1);
    const written = serialise(db.statements);
    for (const fragment of DOB_FRAGMENTS) {
      expect(written).not.toContain(fragment);
    }
    // What DID get written: the derived boolean and nothing more.
    expect(written).toContain('is_minor');
    expect(db.statements[0]?.params).toContain(true);
  });

  it('is not part of the persistable shape at all', () => {
    const update = buildProfileUpdate(
      {
        displayName: 'Ивайло',
        homeCity: 'Пловдив',
        dateOfBirth: DOB,
      },
      NOW,
    );
    expect(Object.keys(update).sort()).toEqual(['displayName', 'homeCity', 'isMinor']);
    expect(JSON.stringify(update)).not.toContain('2012');
    // The whitelist the save path is built from cannot name a date column.
    expect([...PROFILE_PERSISTED_FIELDS].join(' ')).not.toMatch(/dob|birth|date/i);
  });

  it('leaves is_minor untouched when no date is supplied', async () => {
    const db = recordingDb();
    await saveProfile(db, 'user_123', buildProfileUpdate({ displayName: 'Ивайло', homeCity: '' }));
    expect(serialise(db.statements)).not.toContain('is_minor');
  });
});

describe('the date of birth never reaches a log', () => {
  it('is not logged on the success path', async () => {
    const swallow = (): void => undefined;
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      vi.spyOn(console, level as 'log').mockImplementation(swallow),
    );

    const db = recordingDb();
    await saveProfile(
      db,
      'user_123',
      buildProfileUpdate({ displayName: 'Ивайло', homeCity: 'Пловдив', dateOfBirth: DOB }, NOW),
    );

    const logged = spies
      .flatMap((spy) => spy.mock.calls.flat())
      .map(String)
      .join('\n');
    expect(logged).toBe('');
  });

  it('is not carried in the error thrown for an invalid date', () => {
    try {
      buildProfileUpdate({ displayName: 'Ивайло', homeCity: '', dateOfBirth: '2099-12-31' }, NOW);
      expect.unreachable('should have rejected a future date');
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileValidationError);
      // Message, name and stack are all things that end up in error monitoring.
      const rendered = `${String(error)}\n${(error as Error).stack ?? ''}`;
      expect(rendered).not.toContain('2099');
    }
  });
});

describe('nothing in the codebase can persist a date of birth', () => {
  it('declares no date-of-birth column in any schema or migration', () => {
    const files = [
      ...listFiles(path.join(REPO_ROOT, 'db/schema'), /\.ts$/),
      ...listFiles(path.join(REPO_ROOT, 'db/migrations'), /\.sql$/),
    ];
    expect(files.length).toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const file of files) {
      // COMMENT ON bodies are documentation of this very rule ("do not add a
      // DOB column"), not a column — drop them along with the comments.
      const source = stripComments(readFileSync(file, 'utf8')).replace(/COMMENT ON[\s\S]*?';/g, '');
      // Column-shaped mentions only: prose in a comment is stripped above.
      if (/\b(dob|date_of_birth|birth_date|birthday|dateOfBirth)\b/i.test(source)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets the profile action hand the date to nothing but the derivation', () => {
    const actionPath = path.join(WEB_ROOT, 'app/[locale]/profil/actions.ts');
    const source = stripComments(readFileSync(actionPath, 'utf8'));
    const mentions = source.split('\n').filter((line) => /dateOfBirth/.test(line));
    expect(mentions.length).toBeGreaterThan(0);

    // Every mention must sit inside the buildProfileUpdate({...}) argument.
    const call = source.slice(source.indexOf('buildProfileUpdate('));
    const callBody = call.slice(0, call.indexOf('});') + 1);
    for (const mention of mentions) {
      expect(callBody).toContain(mention.trim());
    }
    // And it must never be handed to the database or echoed to the client.
    expect(/saveProfile\([^)]*dateOfBirth/s.test(source)).toBe(false);
    expect(/return[^;]*dateOfBirth/s.test(source)).toBe(false);
  });
});

function listFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, pattern));
    else if (pattern.test(name)) out.push(full);
  }
  return out;
}

/** Blank comment bodies so documentation about the rule is not mistaken for a breach. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');
}
