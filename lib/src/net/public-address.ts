/**
 * Is an address on the PUBLIC internet? — the guard between a URL somebody
 * typed and a request this server makes (webhooks, wave H1). Pure, no
 * dependency, so it is unit-tested address by address.
 *
 * ALLOW-LIST FOR IPv6, DENY-LIST FOR IPv4. IPv4's special ranges are few and
 * fixed (the IANA special-purpose registry); IPv6's are many, so only global
 * unicast (2000::/3) is admitted and its own special blocks are then
 * refused. An IPv4-mapped address (::ffff:a.b.c.d) is judged as the IPv4
 * address it is. Anything unparseable is NOT public.
 *
 * This is one half of the guard. The other is WHERE it runs: on every address
 * the resolver returns at connection time (lib/src/net/safe-post.ts), so a
 * name that resolved somewhere public when the club saved it and somewhere
 * private an hour later (DNS rebinding) is refused when it matters.
 */

type Cidr4 = readonly [number, number];

function v4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** IPv4 ranges that are not the public internet. */
const V4_BLOCKED: readonly Cidr4[] = [
  [v4(0, 0, 0, 0), 8], // "this network"
  [v4(10, 0, 0, 0), 8], // private
  [v4(100, 64, 0, 0), 10], // carrier-grade NAT
  [v4(127, 0, 0, 0), 8], // loopback
  [v4(169, 254, 0, 0), 16], // link-local — cloud metadata lives here
  [v4(172, 16, 0, 0), 12], // private
  [v4(192, 0, 0, 0), 24], // IETF protocol assignments
  [v4(192, 0, 2, 0), 24], // documentation
  [v4(192, 88, 99, 0), 24], // 6to4 relay anycast
  [v4(192, 168, 0, 0), 16], // private
  [v4(198, 18, 0, 0), 15], // benchmarking
  [v4(198, 51, 100, 0), 24], // documentation
  [v4(203, 0, 113, 0), 24], // documentation
  [v4(224, 0, 0, 0), 4], // multicast
  [v4(240, 0, 0, 0), 4], // reserved, and the broadcast address
];

/** A dotted quad as a 32-bit number, or null. No octal, no shorthand. */
export function parseIPv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function inV4(address: number, [base, bits]: Cidr4): boolean {
  const shift = 32 - bits;
  return address >>> shift === base >>> shift;
}

function v4IsPublic(address: number): boolean {
  return !V4_BLOCKED.some((range) => inV4(address, range));
}

function hexGroups(part: string): number[] | null {
  if (part === '') return [];
  const out: number[] = [];
  for (const group of part.split(':')) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

/** Eight 16-bit groups, or null. A zone id (fe80::1%eth0) is not parsed. */
export function parseIPv6(value: string): number[] | null {
  if (value.includes('%')) return null;
  let text = value;
  // A trailing dotted quad (::ffff:1.2.3.4) becomes its two hex groups.
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    if (cut < 0) return null;
    const quad = parseIPv4(text.slice(cut + 1));
    if (quad === null) return null;
    const high = Math.floor(quad / 65536).toString(16);
    const low = (quad % 65536).toString(16);
    text = `${text.slice(0, cut + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = hexGroups(halves[0] ?? '');
  const right = halves.length === 2 ? hexGroups(halves[1] ?? '') : [];
  if (left === null || right === null) return null;
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    return [...left, ...new Array<number>(fill).fill(0), ...right];
  }
  return left.length === 8 ? left : null;
}

function v6IsPublic(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  // ::ffff:a.b.c.d — an IPv4 address in IPv6 clothing: judge the IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return v4IsPublic(g6 * 65536 + g7);
  }
  // Global unicast only (2000::/3) …
  if ((g0 & 0xe000) !== 0x2000) return false;
  // … minus its special blocks.
  if (g0 === 0x2001 && g1 < 0x0200) return false; // 2001::/23 IETF (Teredo, ORCHID, …)
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4 — embeds any IPv4, private included
  if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation (RFC 9637)
  return true;
}

/** Whether `address` (an IPv4 or IPv6 literal, as a resolver returns it) is public. */
export function isPublicAddress(address: string): boolean {
  const ipv4 = parseIPv4(address);
  if (ipv4 !== null) return v4IsPublic(ipv4);
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const ipv6 = parseIPv6(bare);
  return ipv6 !== null && v6IsPublic(ipv6);
}

/** Host names that only ever mean "somewhere inside". */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

export type PublicUrlProblem = 'invalid' | 'not_https' | 'credentials' | 'port' | 'host';

/**
 * A URL this server may be asked to POST to: https, no credentials, the
 * default port (or 8443), and a host NAME that does not mean "inside". An IP
 * literal is refused outright — a public service has a name and a
 * certificate for it — and every address the name resolves to is checked
 * again at connection time.
 */
export function checkPublicHttpsUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; problem: PublicUrlProblem } {
  if (raw.length === 0 || raw.length > 500 || /\s/.test(raw)) {
    return { ok: false, problem: 'invalid' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, problem: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, problem: 'credentials' };
  if (url.port !== '' && url.port !== '8443') return { ok: false, problem: 'port' };
  const host = url.hostname.toLowerCase();
  if (
    host.startsWith('[') ||
    parseIPv4(host) !== null ||
    !host.includes('.') ||
    host.endsWith('.') ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host === 'localhost' ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return { ok: false, problem: 'host' };
  }
  url.hash = '';
  const out = url.toString();
  return out.length > 500 ? { ok: false, problem: 'invalid' } : { ok: true, url: out };
}
