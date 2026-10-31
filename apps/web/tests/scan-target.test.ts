import { describe, expect, it } from 'vitest';

import { scanTarget } from '@/lib/scan-target';

/**
 * The in-app scanner opens a decoded QR only when it is a POPS check-in link
 * (lib/scan-target.ts). A QR is a string anybody can print and stick over the
 * real one, so everything else is refused — and even an accepted code is
 * opened as a PATH on the scanner's own origin, never as the URL it carried.
 */

const ORIGINS = ['https://pops.bg', 'http://localhost:3040'];
const TOKEN = 'b3JpZ2luYWx0b2tlbg~12345~abc_DEF-9';

describe('scanTarget', () => {
  it('opens a public игра code and a club tablet code, locale prefix or not', () => {
    expect(scanTarget(`https://pops.bg/otmetka/${TOKEN}`, ORIGINS)).toBe(`/otmetka/${TOKEN}`);
    expect(scanTarget(`https://pops.bg/en/otmetka/${TOKEN}`, ORIGINS)).toBe(`/otmetka/${TOKEN}`);
    expect(scanTarget(`https://pops.bg/klubove/otmetka/${TOKEN}/`, ORIGINS)).toBe(
      `/klubove/otmetka/${TOKEN}`,
    );
    expect(scanTarget(`  http://localhost:3040/bg/otmetka/${TOKEN}\n`, ORIGINS)).toBe(
      `/otmetka/${TOKEN}`,
    );
  });

  it('refuses another site, even with the same path', () => {
    for (const raw of [
      `https://pops.bg.evil.example/otmetka/${TOKEN}`,
      `https://evil.example/otmetka/${TOKEN}`,
      `http://pops.bg/otmetka/${TOKEN}`,
      `https://pops.bg:8443/otmetka/${TOKEN}`,
    ]) {
      expect(scanTarget(raw, ORIGINS), raw).toBeNull();
    }
  });

  it('refuses any other page of the site, and anything that is not a plain link', () => {
    for (const raw of [
      'https://pops.bg/',
      'https://pops.bg/profil',
      `https://pops.bg/otmetka/${TOKEN}/extra`,
      `https://pops.bg/otmetka/${TOKEN}?next=https://evil.example`,
      `https://pops.bg/otmetka/${TOKEN}#x`,
      `https://user:pw@pops.bg/otmetka/${TOKEN}`,
      'https://pops.bg/otmetka/short',
      'https://pops.bg/otmetka/has%20space1234',
      'https://pops.bg/otmetka/..%2Fprofil1234',
      `javascript:alert(1)//pops.bg/otmetka/${TOKEN}`,
      'WIFI:S:club;T:WPA;P:secret;;',
      '',
      `/otmetka/${TOKEN}`,
    ]) {
      expect(scanTarget(raw, ORIGINS), raw).toBeNull();
    }
  });
});
