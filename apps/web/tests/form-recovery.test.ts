import { describe, expect, it } from 'vitest';

import {
  decodeRecovery,
  encodeRecovery,
  FORM_RECOVERY_TTL_MS,
  pickEntries,
  recoveryKey,
} from '../lib/form-recovery';

/**
 * B2: a form left open across a deploy has to reload before it can send again
 * (FormRecovery.staleForm). What the member typed is carried across that reload
 * in sessionStorage, through an allowlist per form: never the photo (a file
 * can't survive), never the member's own GPS fix (positionLat/positionLon, the
 * proof of being on the spot, re-shared instead of replayed), never a hidden
 * field the new page must issue itself.
 */
const ADD_FORM = ['lon', 'lat', 'sportTypes', 'access', 'name', 'quarter'] as const;

function addFormData(): FormData {
  const data = new FormData();
  data.append('lon', '23.321');
  data.append('lat', '42.697');
  data.append('positionLat', '42.69701');
  data.append('positionLon', '23.32102');
  data.append('photo', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'court.jpg', { type: 'image/jpeg' }));
  data.append('sportTypes', 'basketball');
  data.append('sportTypes', 'football');
  data.append('access', 'free');
  data.append('name', 'Игрище „Изгрев“');
  data.append('quarter', 'Изгрев');
  data.append('$ACTION_ID_4062b0', '');
  return data;
}

describe('form recovery across a forced reload', () => {
  it('keeps the allowed fields in order, repeated names included', () => {
    expect(pickEntries(addFormData(), ADD_FORM)).toEqual([
      ['lon', '23.321'],
      ['lat', '42.697'],
      ['sportTypes', 'basketball'],
      ['sportTypes', 'football'],
      ['access', 'free'],
      ['name', 'Игрище „Изгрев“'],
      ['quarter', 'Изгрев'],
    ]);
  });

  it('never keeps the photo, the GPS fix or a field outside the allowlist', () => {
    const names = pickEntries(addFormData(), ADD_FORM).map(([name]) => name);
    expect(names).not.toContain('photo');
    expect(names).not.toContain('positionLat');
    expect(names).not.toContain('positionLon');
    expect(names).not.toContain('$ACTION_ID_4062b0');
  });

  it('round-trips through the stored text', () => {
    const entries = pickEntries(addFormData(), ADD_FORM);
    const now = Date.UTC(2026, 9, 12, 16, 30);
    expect(decodeRecovery(encodeRecovery(entries, now), now + 60_000, ADD_FORM)).toEqual(entries);
  });

  it('drops a copy older than the time limit', () => {
    const now = Date.UTC(2026, 9, 12, 16, 30);
    const raw = encodeRecovery([['name', 'x']], now);
    expect(decodeRecovery(raw, now + FORM_RECOVERY_TTL_MS + 1, ADD_FORM)).toBeNull();
  });

  it('ignores nothing stored, broken text and another version', () => {
    const now = Date.UTC(2026, 9, 12, 16, 30);
    expect(decodeRecovery(null, now, ADD_FORM)).toBeNull();
    expect(decodeRecovery('{not json', now, ADD_FORM)).toBeNull();
    expect(decodeRecovery(JSON.stringify({ v: 99, at: now, entries: [] }), now, ADD_FORM)).toBeNull();
  });

  it('filters again on the way back in', () => {
    const now = Date.UTC(2026, 9, 12, 16, 30);
    const raw = JSON.stringify({
      v: 1,
      at: now,
      entries: [
        ['name', 'x'],
        ['positionLat', '42.7'],
        ['access', 7],
      ],
    });
    expect(decodeRecovery(raw, now, ADD_FORM)).toEqual([['name', 'x']]);
  });

  it('keys the copy by form and page', () => {
    expect(recoveryKey('add', '/dobavi')).toBe('pops:form-recovery:add:/dobavi');
  });
});
