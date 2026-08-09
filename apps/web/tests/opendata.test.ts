import { EXPORT_DATASETS, OPEN_DATA_LICENSE } from '@sportkarta/lib/opendata';
import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

import {
  generateApiKey,
  hashApiKey,
  keyPrefixOf,
  labelLooksLikeKey,
  looksLikeApiKey,
  MAX_KEYS_PER_ACCOUNT,
} from '@/lib/opendata/keys';
import { chargeOpenDataRequest, OPEN_DATA_LIMITS, rateLimitHeaders } from '@/lib/opendata/limits';
import { corsHeaders, licenseHeaders } from '@/lib/opendata/response';

/**
 * The web-side open-data guarantees (Stage 6.1).
 *
 * The catalogue and the SQL are covered in lib and db; this covers the three
 * things that only exist at the HTTP edge — the key format, the soft limit's
 * behaviour, and the promise that every response states its licence — plus the
 * catalogue↔i18n coupling that makes "a field cannot be exported undocumented"
 * true in both languages rather than only in Bulgarian.
 */

function lookup(catalogue: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[key];
  }, catalogue);
}

describe('a field cannot be exported undocumented', () => {
  // The /danni field tables render from the catalogue's i18n keys. If a key
  // does not resolve, next-intl renders the key itself — visible, but only to
  // whoever happens to load the page in that language. This is the check that
  // does not depend on anybody loading the page.
  const cases = EXPORT_DATASETS.flatMap((dataset) => [
    { label: `${dataset.id} title`, path: `OpenData.datasets.${dataset.titleKey}` },
    { label: `${dataset.id} description`, path: `OpenData.datasets.${dataset.descriptionKey}` },
    ...dataset.fields.map((field) => ({
      label: `${dataset.id}.${field.name}`,
      path: `OpenData.fields.${field.descriptionKey}`,
    })),
  ]);

  it('has something to check', () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  it.each(cases)('$label resolves in bg', ({ path }) => {
    expect(typeof lookup(bg, path)).toBe('string');
  });

  it.each(cases)('$label resolves in en', ({ path }) => {
    expect(typeof lookup(en, path)).toBe('string');
  });
});

describe('API key format', () => {
  it('is a recognisable, high-entropy token', () => {
    const key = generateApiKey();
    expect(key.startsWith('skbg_')).toBe(true);
    // 32 random bytes as base64url. The visible marker is what makes a leaked
    // key reportable by a secret scanner instead of an anonymous blob.
    expect(key).toHaveLength('skbg_'.length + 43);
    expect(looksLikeApiKey(key)).toBe(true);
  });

  it('does not repeat itself', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey()));
    expect(keys.size).toBe(200);
  });

  it('hashes to something the api_keys CHECK will accept, and the key does not', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    // The migration's constraint, restated where the writer lives: a 64-char
    // lowercase hex string is storable, and the key itself is structurally not.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic to hash and stable to prefix', () => {
    const key = 'skbg_' + 'A'.repeat(43);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(keyPrefixOf(key)).toBe('skbg_AAAAAA');
    // The stored prefix must satisfy api_keys_prefix_shape exactly.
    expect(keyPrefixOf(key)).toMatch(/^skbg_[A-Za-z0-9_-]{6}$/);
  });

  it('rejects anything that could not have been issued', () => {
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('skbg_short')).toBe(false);
    expect(looksLikeApiKey('A'.repeat(48))).toBe(false);
    // A session cookie pasted into the Authorization header.
    expect(looksLikeApiKey('better-auth.session_token=abc.def')).toBe(false);
    // The right length, wrong alphabet — base64 with + and / rather than url.
    expect(looksLikeApiKey('skbg_' + '+'.repeat(43))).toBe(false);
  });

  it('refuses a label that contains a key, before the database has to', () => {
    // api_keys_label_no_key is what makes this true; issueApiKey checks it too
    // so the member gets a sentence rather than a 500 from SQLSTATE 23514.
    expect(labelLooksLikeKey(generateApiKey())).toBe(true);
    expect(labelLooksLikeKey('my key is skbg_abc123 oops')).toBe(true);
    expect(labelLooksLikeKey('Grant report sync')).toBe(false);
    expect(labelLooksLikeKey('sk_test_notours')).toBe(false);
  });

  it('caps keys per account at a number a member can resolve alone', () => {
    expect(MAX_KEYS_PER_ACCOUNT).toBeGreaterThan(1);
    expect(MAX_KEYS_PER_ACCOUNT).toBeLessThan(20);
  });
});

describe('soft limits', () => {
  it('gives a keyed caller a bigger budget than an anonymous one', () => {
    expect(OPEN_DATA_LIMITS.keyedPerMinute).toBeGreaterThan(OPEN_DATA_LIMITS.anonPerMinute);
  });

  it('allows well under the limit and refuses over it, per identity', () => {
    const ip = `203.0.113.${String(Math.floor(Math.random() * 250) + 1)}`;
    let lastAllowed = true;
    for (let i = 0; i < OPEN_DATA_LIMITS.anonPerMinute; i += 1) {
      lastAllowed = chargeOpenDataRequest(null, ip).allowed;
    }
    expect(lastAllowed).toBe(true);
    const over = chargeOpenDataRequest(null, ip);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('charges the key rather than the IP when one is presented', () => {
    // Two callers behind one NAT address must not spend each other's budget,
    // which is the practical reason a key raises the limit at all.
    const ip = '203.0.113.254';
    const keyed = chargeOpenDataRequest('key-a', ip);
    expect(keyed.limit).toBe(OPEN_DATA_LIMITS.keyedPerMinute);
    expect(chargeOpenDataRequest(null, ip).limit).toBe(OPEN_DATA_LIMITS.anonPerMinute);
  });

  it('fails OPEN when the caller cannot be identified at all', () => {
    // No proxy header means something is misconfigured, not that somebody is
    // attacking. An open-data API that goes dark over it is the worse failure.
    expect(chargeOpenDataRequest(null, null).allowed).toBe(true);
  });

  it('advertises the budget on every response, not only on refusals', () => {
    const headers = rateLimitHeaders(chargeOpenDataRequest('key-b', null));
    expect(headers['RateLimit-Limit']).toBe(String(OPEN_DATA_LIMITS.keyedPerMinute));
    expect(headers).toHaveProperty('RateLimit-Remaining');
    expect(headers).toHaveProperty('RateLimit-Reset');
  });
});

describe('every response states its licence', () => {
  it('names the ODbL and the exact attribution string', () => {
    const headers = licenseHeaders();
    expect(headers['X-License']).toBe('ODbL-1.0');
    // ASCII by construction: a header value is latin-1, so the © form would
    // reach every client as "Â©" — in the one field meant to be machine-read.
    expect(headers['X-Attribution']).toBe('(c) OpenStreetMap contributors + POPS community');
    expect(/^[\x20-\x7e]*$/.test(headers['X-Attribution'] ?? '')).toBe(true);
    expect(/^[\x20-\x7e]*$/.test(headers.Link ?? '')).toBe(true);
    expect(headers.Link).toContain('rel="license"');
    expect(headers.Link).toContain('/danni/litsenz');
  });

  it('uses one attribution constant everywhere', () => {
    // The header, the licence page, the GeoJSON member and every dump's
    // LICENSE.txt all render from this. Two copies would be one wrong copy.
    expect(OPEN_DATA_LICENSE.attribution).toBe('© OpenStreetMap contributors + POPS community');
    expect(licenseHeaders()['X-Attribution']).toBe(OPEN_DATA_LICENSE.attributionAscii);
    // The two differ only in the copyright sign — same attribution, one of
    // them transportable in a header.
    expect(OPEN_DATA_LICENSE.attributionAscii).toBe(
      OPEN_DATA_LICENSE.attribution.replace('©', '(c)'),
    );
  });

  it('is CORS-open for GET, and advertises no credentialed mode', () => {
    const headers = corsHeaders();
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
    // The one that matters: a wildcard origin plus credentials would let any
    // page on the internet read the API as whoever is signed in here.
    expect(headers).not.toHaveProperty('Access-Control-Allow-Credentials');
    expect(headers['Access-Control-Allow-Headers']).toBe('Authorization');
  });
});
