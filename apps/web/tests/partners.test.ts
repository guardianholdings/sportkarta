import { describe, expect, it } from 'vitest';

import { buildPartnerInput, PartnerInputError } from '@/lib/partners';

/** The pure form → input gate for the partners registry (MONETISATION M1). */

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const VALID = {
  slug: 'decathlon',
  tier: 'category',
  nameBg: 'Декатлон България',
  url: 'https://www.decathlon.bg',
};

describe('buildPartnerInput', () => {
  it('accepts a minimal valid partner and defaults the rest', () => {
    const input = buildPartnerInput(form(VALID));
    expect(input).toMatchObject({
      slug: 'decathlon',
      tier: 'category',
      nameBg: 'Декатлон България',
      nameEn: null,
      blurbBg: null,
      url: 'https://www.decathlon.bg',
      visible: false,
      sortOrder: 0,
      startsOn: null,
      endsOn: null,
    });
  });

  it('normalizes the slug to lowercase and validates its shape', () => {
    expect(buildPartnerInput(form({ ...VALID, slug: 'DecathLon' })).slug).toBe('decathlon');
    expect(() => buildPartnerInput(form({ ...VALID, slug: 'не-латиница' }))).toThrowError(
      new PartnerInputError('bad_slug'),
    );
  });

  it('refuses an unknown tier — the form cannot invent one', () => {
    expect(() => buildPartnerInput(form({ ...VALID, tier: 'platinum' }))).toThrowError(
      new PartnerInputError('bad_tier'),
    );
  });

  it('requires the Bulgarian name; English is optional', () => {
    expect(() => buildPartnerInput(form({ ...VALID, nameBg: '  ' }))).toThrowError(
      new PartnerInputError('name_required'),
    );
  });

  it('rejects URLs that are not http(s) or contain whitespace', () => {
    expect(() => buildPartnerInput(form({ ...VALID, url: 'javascript:alert(1)' }))).toThrowError(
      new PartnerInputError('bad_url'),
    );
    expect(() => buildPartnerInput(form({ ...VALID, url: 'https:// evil' }))).toThrowError(
      new PartnerInputError('bad_url'),
    );
  });

  it('rejects an inverted window, matching the CHECK', () => {
    expect(() =>
      buildPartnerInput(form({ ...VALID, startsOn: '2026-12-31', endsOn: '2026-01-01' })),
    ).toThrowError(new PartnerInputError('window_order'));
  });

  it('reads the visible checkbox and the sort order', () => {
    const input = buildPartnerInput(form({ ...VALID, visible: 'on', sortOrder: '5' }));
    expect(input.visible).toBe(true);
    expect(input.sortOrder).toBe(5);
    expect(() => buildPartnerInput(form({ ...VALID, sortOrder: 'abc' }))).toThrowError(
      new PartnerInputError('bad_sort'),
    );
  });
});
