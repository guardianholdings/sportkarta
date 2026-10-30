import { describe, expect, it } from 'vitest';

import { parseSignature } from '@/lib/clubs/input';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe('parseSignature', () => {
  it('reads an absent signer as the client — the portal sends none', () => {
    expect(parseSignature(form({ signerName: 'Мария', accept: 'on' }))).toEqual({
      ok: true,
      value: { signerName: 'Мария', signerKind: 'self' },
    });
  });

  it("takes the desk's choice for a minor's record", () => {
    for (const signer of ['self', 'guardian'] as const) {
      expect(parseSignature(form({ signerName: 'Мария', signer, accept: 'on' }))).toEqual({
        ok: true,
        value: { signerName: 'Мария', signerKind: signer },
      });
    }
  });

  it('refuses a signer outside the list, and still reports the other errors', () => {
    expect(parseSignature(form({ signerName: 'Мария', signer: 'staff', accept: 'on' }))).toEqual({
      ok: false,
      errors: ['signer_kind_invalid'],
    });
    expect(parseSignature(form({ signerName: '', signer: 'staff' }))).toEqual({
      ok: false,
      errors: ['signer_name_required', 'signer_kind_invalid', 'accept_required'],
    });
  });
});
