import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { groupOfficeSections, OFFICE_HUBS, OFFICE_SECTIONS } from '@/lib/clubs/office-nav';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The office's 23 sections in seven hubs (operator decision 2026-10-31). The
 * grouping is data, so its rules are checked here: a section cannot be in two
 * hubs or in none, a hub cannot name a section that does not exist, and every
 * office route belongs somewhere — a page in no hub would light nothing.
 */

const OFFICE_DIR = path.join(__dirname, '..', 'app', '[locale]', 'klub', '[slug]', '(office)');

describe('the office hubs', () => {
  it('are the seven the operator chose, in order', () => {
    expect(OFFICE_HUBS.map((h) => bg.ClubOffice.hubs[h.key])).toEqual([
      'Табло',
      'Присъствия',
      'График',
      'Членове',
      'Пари',
      'Общуване',
      'Настройки',
    ]);
    for (const hub of OFFICE_HUBS) expect(en.ClubOffice.hubs[hub.key]).toBeTruthy();
  });

  it('put every section in exactly one hub, and name no other', () => {
    const grouped = OFFICE_HUBS.flatMap((h) => [...h.segments]);
    expect([...grouped].sort()).toEqual(OFFICE_SECTIONS.map((s) => s.segment).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(OFFICE_SECTIONS).toHaveLength(23);
  });

  it('cover every office route', () => {
    const routes = readdirSync(OFFICE_DIR).filter((name) =>
      statSync(path.join(OFFICE_DIR, name)).isDirectory(),
    );
    const known = new Set<string>(OFFICE_HUBS.flatMap((h) => [...h.segments, ...h.also]));
    expect(routes.filter((r) => !known.has(r))).toEqual([]);
  });

  it('leave out a hub none of whose sections may be seen, and keep the order', () => {
    const visible = OFFICE_SECTIONS.filter((s) =>
      ['tablo', 'prisastviya', 'kalendar', 'grafik'].includes(s.segment),
    );
    expect(
      groupOfficeSections(visible).map((h) => [h.key, h.sections.map((s) => s.segment)]),
    ).toEqual([
      ['dashboard', ['tablo']],
      ['attendance', ['prisastviya']],
      ['schedule', ['grafik', 'kalendar']],
    ]);
  });

  it('call the rooms and courts that, not «Съоръжения» — the map’s word for public facilities', () => {
    expect(bg.ClubOffice.nav.resources).toBe('Зали и кортове');
  });
});
