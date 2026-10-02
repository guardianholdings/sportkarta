import { describe, expect, it } from 'vitest';

import { routing } from '@/i18n/routing';
import {
  isProtectedPath,
  PROFILE_PATH,
  safeDestination,
  signInDestination,
  signInHref,
  withoutLocalePrefix,
} from '@/lib/sign-in-destination';

describe('withoutLocalePrefix', () => {
  it('strips a leading locale segment and nothing else', () => {
    expect(withoutLocalePrefix('/en/obekt/ndk')).toBe('/obekt/ndk');
    expect(withoutLocalePrefix('/bg/profil')).toBe('/profil');
    expect(withoutLocalePrefix('/en')).toBe('/');
    expect(withoutLocalePrefix('/en?z=7')).toBe('/?z=7');
    expect(withoutLocalePrefix('/obekt/ndk')).toBe('/obekt/ndk');
    // A slug that merely starts with a locale's letters is not a prefix.
    expect(withoutLocalePrefix('/english-court')).toBe('/english-court');
    expect(withoutLocalePrefix('/bgarena')).toBe('/bgarena');
  });

  it('assumes the as-needed prefix mode the rest of this module is written for', () => {
    // Callers render the unprefixed result through next-intl, which adds the
    // prefix back per locale. If routing ever moves to `always`, re-check that
    // stripping still round-trips.
    expect(routing.localePrefix).toBe('as-needed');
    expect(routing.defaultLocale).toBe('bg');
  });
});

describe('signInDestination', () => {
  it('lands on the requested page, whatever locale prefix it carried', () => {
    // Middleware sends prefixed paths, page links unprefixed ones; the member
    // lands in the language they signed in with either way.
    expect(signInDestination('/en/dobavi')).toBe('/dobavi');
    expect(signInDestination('/obekt/way-103530116')).toBe('/obekt/way-103530116');
    expect(signInDestination('/en/sesiya/0f8c3a52-6b1e-4c1a-9d59-1f0b7b6b2d10')).toBe(
      '/sesiya/0f8c3a52-6b1e-4c1a-9d59-1f0b7b6b2d10',
    );
  });

  it('falls back to the profile when there is nowhere safe to go', () => {
    for (const next of [null, undefined, '', 42, ['/admin'], 'https://evil.example']) {
      expect(signInDestination(next), JSON.stringify(next)).toBe(PROFILE_PATH);
    }
  });

  it('re-validates after stripping the prefix', () => {
    // Harmless as a path, protocol-relative once "/en" comes off.
    expect(safeDestination('/en//evil.example')).toBeNull();
    expect(signInDestination('/en//evil.example')).toBe(PROFILE_PATH);
    expect(safeDestination('/bg//evil.example/x')).toBeNull();
  });

  it('never sends a signed-in member back to the sign-in page', () => {
    // /vhod bounces a signed-in visitor to its `next`; /vhod as `next` would loop.
    for (const next of ['/vhod', '/en/vhod', '/vhod?next=/admin', '/vhod/']) {
      expect(signInDestination(next), next).toBe(PROFILE_PATH);
    }
    expect(signInDestination('/vhodni-tochki')).toBe('/vhodni-tochki');
  });
});

describe('signInHref', () => {
  it('carries the page to come back to', () => {
    expect(signInHref('/sesiya/abc')).toEqual({
      pathname: '/vhod',
      query: { next: '/sesiya/abc' },
    });
    // The header middleware sets is the prefixed external path.
    expect(signInHref('/en/trenirovki')).toEqual({
      pathname: '/vhod',
      query: { next: '/trenirovki' },
    });
  });

  it('drops a destination it would refuse later anyway', () => {
    for (const next of [null, undefined, '', '//evil.example', '/vhod']) {
      expect(signInHref(next), String(next)).toEqual({ pathname: '/vhod' });
    }
  });
});

describe('isProtectedPath', () => {
  it('guards the signed-in areas in both locales', () => {
    for (const path of [
      '/admin',
      '/admin/verify',
      '/profil',
      '/en/profil',
      '/dobavi',
      '/trenirovki',
      '/en/trenirovki',
      '/pasport',
      '/en/pasport/',
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });

  it('leaves public pages alone, including somebody else’s public passport', () => {
    for (const path of ['/', '/vhod', '/en/vhod', '/obekt/ndk', '/pasport/ivan', '/klasirane']) {
      expect(isProtectedPath(path), path).toBe(false);
    }
  });
});
