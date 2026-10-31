import type { LookupAddress } from 'node:dns';

import { describe, expect, it } from 'vitest';

import { checkPublicHttpsUrl, isPublicAddress, parseIPv6 } from './public-address.js';
import { publicOnlyLookup, safePost } from './safe-post.js';

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.7',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2001:db8::1',
    '2001::1',
    '2002:a00:1::1',
    '3fff::1',
    '[::1]',
    'fe80::1%eth0',
    'not an address',
    '1.2.3',
    '01.2.3.4',
    '256.1.1.1',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '193.0.6.139',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8',
    '[2606:4700:4700::1111]',
  ])('admits %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('parses IPv6 forms into eight groups', () => {
    expect(parseIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7::8')).toBeNull();
    expect(parseIPv6('12345::')).toBeNull();
  });
});

describe('checkPublicHttpsUrl', () => {
  it('admits an https URL on a public-looking name', () => {
    expect(checkPublicHttpsUrl('https://hooks.example.com/pops?x=1')).toEqual({
      ok: true,
      url: 'https://hooks.example.com/pops?x=1',
    });
    expect(checkPublicHttpsUrl('https://Hooks.Example.com:8443')).toEqual({
      ok: true,
      url: 'https://hooks.example.com:8443/',
    });
  });

  it('drops a fragment, which is never sent anyway', () => {
    expect(checkPublicHttpsUrl('https://a.example.com/x#y')).toEqual({
      ok: true,
      url: 'https://a.example.com/x',
    });
  });

  it('admits an internationalised name as its punycode', () => {
    const result = checkPublicHttpsUrl('https://пример.бг/');
    expect(result.ok && /^https:\/\/xn--/.test(result.url)).toBe(true);
  });

  it.each([
    ['http://hooks.example.com/', 'not_https'],
    ['ftp://hooks.example.com/', 'not_https'],
    ['https://user:pw@hooks.example.com/', 'credentials'],
    ['https://hooks.example.com:22/', 'port'],
    ['https://127.0.0.1/', 'host'],
    ['https://2130706433/', 'host'],
    ['https://0x7f.1/', 'host'],
    ['https://[::1]/', 'host'],
    ['https://localhost/', 'host'],
    ['https://printer.local/', 'host'],
    ['https://db.internal/', 'host'],
    ['https://router.home.arpa/', 'host'],
    ['https://intranet/', 'host'],
    ['https://example.com./', 'host'],
    ['https://hooks.example.com/a b', 'invalid'],
    ['not a url', 'invalid'],
    ['', 'invalid'],
  ])('refuses %s (%s)', (raw, problem) => {
    expect(checkPublicHttpsUrl(raw)).toEqual({ ok: false, problem });
  });
});

describe('the connection-time guard', () => {
  it('refuses a NAME that resolves to a private address', async () => {
    // localhost resolves to loopback on every machine: no network needed.
    const outcome = await new Promise<{ code: string | undefined; address: unknown }>((resolve) => {
      publicOnlyLookup('localhost', { all: true }, (err, address) => {
        resolve({ code: err?.code, address });
      });
    });
    expect(outcome.code).toBe('POPS_ADDRESS_BLOCKED');
  });

  it('hands a public answer through in the shape the socket asked for', async () => {
    // An IP literal "resolves" to itself without a network round trip.
    const single = await new Promise<unknown[]>((resolve) => {
      publicOnlyLookup('1.1.1.1', {}, (err, address, family) => resolve([err, address, family]));
    });
    expect(single).toEqual([null, '1.1.1.1', 4]);
    const all = await new Promise<LookupAddress[] | string>((resolve) => {
      publicOnlyLookup('1.1.1.1', { all: true }, (_err, address) => resolve(address));
    });
    expect(all).toEqual([{ address: '1.1.1.1', family: 4 }]);
  });

  it('safePost refuses an address before it connects', async () => {
    expect(await safePost('https://127.0.0.1/', '{}', {})).toEqual({
      ok: false,
      status: null,
      error: 'address_blocked',
    });
    expect(await safePost('http://hooks.example.com/', '{}', {})).toEqual({
      ok: false,
      status: null,
      error: 'address_blocked',
    });
  });
});
