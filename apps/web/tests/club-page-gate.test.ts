import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The demo club (status `demo`) opens the office pages view-only through the
 * page gate, requireClubPage, which returns a context nobody signed in for. The
 * split is held at the source: the office layout and every office page call
 * the page gate, and no actions file or API route may, so every save keeps
 * requireClubStaff (a sign-in and a staff grant), on top of the status check
 * that each write statement embeds.
 */
const app = path.join(__dirname, '..', 'app');
const office = path.join(app, '[locale]', 'klub', '[slug]', '(office)');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(app);
const officeViews = walk(office).filter((file) => /(page|layout)\.tsx$/.test(file));
const actions = files.filter((file) => file.endsWith('actions.ts'));
const officeActions = actions.filter((file) => file.startsWith(office));
const routes = files.filter((file) => file.endsWith('route.ts'));
const read = (file: string): string => readFileSync(file, 'utf8');

describe('the office page gate and the demo club', () => {
  it('finds the office layout, its pages and their actions', () => {
    expect(officeViews).toContain(path.join(office, 'layout.tsx'));
    expect(officeViews.length).toBeGreaterThanOrEqual(51);
    expect(officeActions.length).toBeGreaterThanOrEqual(24);
  });

  it('gates the office layout and every office page with requireClubPage', () => {
    for (const file of officeViews) {
      const source = read(file);
      expect(source, file).toMatch(/\brequireClubPage\(/);
      expect(source, file).not.toMatch(/\brequireClubStaff/);
    }
  });

  it('keeps every actions file and API route off the page gate', () => {
    for (const file of [...actions, ...routes]) {
      expect(read(file), file).not.toMatch(/\brequireClubPage/);
    }
  });

  it('keeps every office action on the staff gate', () => {
    for (const file of officeActions) {
      expect(read(file), file).toMatch(/\brequireClubStaff\(/);
    }
  });
});
