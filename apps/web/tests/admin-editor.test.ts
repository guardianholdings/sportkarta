import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listHref, safeAdminBack } from '@/lib/admin-back';
import { describeEditValue, isMarkerEdit, type EditValueWords } from '@/lib/admin-edit-values';

/**
 * The facility editor after the UX audit of 2026-10-10: it returns to the list
 * the operator came from (A-9), prints its history in words (A-14), keeps the
 * operator's input on a refusal (A-2) and leaves the status to moderation (A-4).
 */

const LIST = '/admin/facilities';

describe('safeAdminBack', () => {
  it('keeps the list with its filters and page', () => {
    expect(safeAdminBack('/admin/facilities', LIST)).toBe('/admin/facilities');
    expect(safeAdminBack('/admin/facilities?status=needs_verification&page=3', LIST)).toBe(
      '/admin/facilities?status=needs_verification&page=3',
    );
  });

  it('refuses anything that is not that list, on this site', () => {
    for (const value of [
      'https://evil.example/admin/facilities',
      '//evil.example/admin/facilities',
      '/\\evil.example',
      '/admin/akaunti',
      '/admin/facilitiesX',
      '/admin/facilities/../akaunti',
      '/en/admin/facilities',
      '/admin/facilities?x=1\r\nSet-Cookie: a=b',
      `/admin/facilities?${'q'.repeat(600)}`,
      '',
      undefined,
      ['/admin/facilities'],
    ]) {
      expect(safeAdminBack(value, LIST), String(value)).toBeNull();
    }
  });

  it('builds the list URL the editor is handed, without empty parameters', () => {
    expect(listHref(LIST, { q: 'парк', municipality: '', page: '2' })).toBe(
      '/admin/facilities?q=%D0%BF%D0%B0%D1%80%D0%BA&page=2',
    );
    expect(listHref(LIST, {})).toBe(LIST);
    const built = listHref(LIST, { status: 'gone', page: '4' });
    expect(safeAdminBack(built, LIST)).toBe(built);
  });
});

describe('describeEditValue', () => {
  const words: EditValueWords = {
    none: 'няма',
    yes: 'да',
    no: 'не',
    access: (value) => `access:${value}`,
    status: (value) => `status:${value}`,
    surface: (value) => `surface:${value}`,
    condition: (value) => `condition:${value}`,
    sport: (value) => ({ football: 'футбол', basketball: 'баскетбол' })[value] ?? value,
    municipality: (id) => (id === 68 ? 'Столична' : undefined),
  };

  it('prints sports, booleans and nothing in words, not JSON', () => {
    expect(describeEditValue('sport_types', ['football', 'basketball'], words)).toBe(
      'футбол, баскетбол',
    );
    expect(describeEditValue('sport_types', [], words)).toBe('няма');
    expect(describeEditValue('covered', true, words)).toBe('да');
    expect(describeEditValue('surface', null, words)).toBe('няма');
    expect(describeEditValue('status', 'gone', words)).toBe('status:gone');
    expect(describeEditValue('access_proposed', 'paid', words)).toBe('access:paid');
  });

  it('prints a moved pin as coordinates and a municipality by its name', () => {
    expect(describeEditValue('geom', { lon: 23.3219335, lat: 42.6977085 }, words)).toBe(
      '42.697708, 23.321934',
    );
    expect(describeEditValue('municipality_id', 68, words)).toBe('Столична');
    expect(describeEditValue('municipality_id', 999, words)).toBe('999');
  });

  it('knows the edits that changed no column', () => {
    expect(['created', 'verified', 'reported_missing'].every(isMarkerEdit)).toBe(true);
    expect(isMarkerEdit('access')).toBe(false);
  });
});

describe('the editor action', () => {
  const ADMIN = path.join(process.cwd(), 'app', '[locale]', 'admin', '(protected)');
  const action = readFileSync(path.join(ADMIN, 'facilities', 'actions.ts'), 'utf8');
  const page = readFileSync(path.join(ADMIN, 'facilities', '[id]', 'page.tsx'), 'utf8');

  it('never writes the status: that is a logged moderation decision (A-4)', () => {
    expect(action).not.toMatch(/formData\.get\('status'\)/);
    expect(action).not.toMatch(/status = \$\{/);
    expect(page).not.toMatch(/name="status"/);
    // The editor decides a facility awaiting verification through the same
    // scoped, logged action as /admin/moderation.
    expect(page).toMatch(/decideFacility\.bind\(null, facility\.id, 'gone'/);
    expect(page).toMatch(/context="facility_gone"/);
  });

  it('returns a refusal as state instead of redirecting away from the input (A-2)', () => {
    expect(action).not.toMatch(/redirect\(/);
    expect(action).toMatch(/return \{ error: 'location' \}/);
    expect(action).toMatch(/return \{ error: 'scope' \}/);
  });
});
