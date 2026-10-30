import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';

import { checkPublicHttpsUrl, isPublicAddress } from './public-address.js';

/**
 * POST to a URL somebody else chose — a club's webhook endpoint (wave H1) —
 * without letting it reach anything inside. SERVER ONLY.
 *
 *  - The URL is re-checked (https, a public-looking NAME, no credentials).
 *  - EVERY address the resolver returns is checked at connection time, in the
 *    socket's own lookup, and one private address refuses the lot: the check
 *    and the connection use the same answer, so DNS rebinding has no gap to
 *    use.
 *  - No keep-alive agent (each request resolves afresh), no redirect followed
 *    (a 3xx is a failure, never a second request), a hard deadline, and the
 *    response body is never read.
 */

export type SafePostError =
  'timeout' | 'dns' | 'address_blocked' | 'connection' | 'tls' | 'redirect' | 'http_status';

export interface SafePostResult {
  ok: boolean;
  status: number | null;
  error: SafePostError | null;
}

const BLOCKED = 'POPS_ADDRESS_BLOCKED';
const DEADLINE = 'POPS_DEADLINE';

function coded(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** The socket's resolver: every answer must be public, or none is used. Exported for tests. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list: LookupAddress[] = addresses;
    const first = list[0];
    if (!first || list.some((entry) => !isPublicAddress(entry.address))) {
      callback(coded('address is not public', BLOCKED), '', 0);
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, first.address, first.family);
  });
};

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'EAI_FAIL', 'EAI_NONAME']);

function classify(error: NodeJS.ErrnoException): SafePostError {
  const code = error.code ?? '';
  if (code === BLOCKED) return 'address_blocked';
  if (code === DEADLINE || code === 'ETIMEDOUT') return 'timeout';
  if (DNS_CODES.has(code)) return 'dns';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'tls';
  return 'connection';
}

export async function safePost(
  rawUrl: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  options: { timeoutMs?: number } = {},
): Promise<SafePostResult> {
  const checked = checkPublicHttpsUrl(rawUrl);
  if (!checked.ok) return { ok: false, status: null, error: 'address_blocked' };
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<SafePostResult>((resolve) => {
    let settled = false;
    const req = request(
      checked.url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: publicOnlyLookup,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // The body is never read: a receiver's answer is its status.
        res.destroy();
        req.destroy();
        if (status >= 200 && status < 300) finish({ ok: true, status, error: null });
        else if (status >= 300 && status < 400) finish({ ok: false, status, error: 'redirect' });
        else finish({ ok: false, status: status || null, error: 'http_status' });
      },
    );
    const timer = setTimeout(() => req.destroy(coded('deadline passed', DEADLINE)), timeoutMs);
    // Hoisted: every callback above runs later, after the timer exists.
    function finish(result: SafePostResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    req.on('timeout', () => req.destroy(coded('socket idle', DEADLINE)));
    req.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, status: null, error: classify(error) });
    });
    req.end(body);
  });
}
