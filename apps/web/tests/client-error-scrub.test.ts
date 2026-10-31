import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ErrorEvent } from '@sentry/browser';
import { describe, expect, it } from 'vitest';

import { scrubBreadcrumb, scrubEvent, scrubText, scrubUrl } from '@/lib/client-error-scrub';

const TOKEN = 'abcdef0123456789abcdef0123456789abcdef01';

describe('browser error reports are scrubbed before they leave the page', () => {
  it('scrubUrl drops the query, the fragment and tokenised segments', () => {
    expect(scrubUrl('https://pops.bg/karta?lat=42.69&lng=23.32#x')).toBe('https://pops.bg/karta');
    expect(scrubUrl(`/otmetka/${TOKEN}?from=qr`)).toBe('/otmetka/[token]');
    expect(scrubUrl('/pasport/ivan-petrov')).toBe('/pasport/[token]');
  });

  it('scrubText hides addresses, tokens, IPs, numbers and queries', () => {
    const text = `ivan@example.org asked /s/${TOKEN}?x=1 from 10.0.0.7 on +359 88 123 4567, id ${TOKEN}`;
    const out = scrubText(text);
    expect(out).not.toContain('ivan@');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('10.0.0.7');
    expect(out).not.toContain('123 4567');
    expect(out).toContain('[email]');
    expect(out).toContain('[token]');
  });

  it('drops console breadcrumbs and scrubs navigation and fetch ones', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'user ivan@example.org' })).toBeNull();
    const nav = scrubBreadcrumb({
      category: 'navigation',
      data: { from: `/klubove/pokana/${TOKEN}`, to: '/klub/zala/az?welcome=1' },
    });
    expect(nav?.data).toEqual({ from: '/klubove/pokana/[token]', to: '/klub/zala/az' });
    const fetch = scrubBreadcrumb({
      category: 'fetch',
      data: { url: `https://pops.bg/api/profil/eksport?token=${TOKEN}`, method: 'GET', body: 'x' },
    });
    expect(fetch?.data).toEqual({ url: 'https://pops.bg/api/profil/eksport', method: 'GET' });
  });

  it('scrubEvent removes the person and scrubs every address and message', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: `failed for ivan@example.org at /otmetka/${TOKEN}`,
      transaction: `/klubove/pokana/${TOKEN}`,
      user: { id: 'u1', email: 'ivan@example.org' },
      extra: { formData: 'secret' },
      request: {
        url: `https://pops.bg/sedmitsata/otpisvane/${TOKEN}?utm=1`,
        headers: {
          Referer: `https://pops.bg/pasport/ivan-petrov`,
          Cookie: 'session=abc',
          'User-Agent': 'x',
        },
        cookies: { session: 'abc' },
        query_string: 'utm=1',
        data: { email: 'ivan@example.org' },
      },
      exception: { values: [{ type: 'Error', value: `code ${TOKEN} for ivan@example.org` }] },
      breadcrumbs: [
        { category: 'console', message: 'noise' },
        { category: 'navigation', data: { from: '/', to: `/s/${TOKEN}` } },
      ],
    };
    const out = scrubEvent(event);
    expect(out.user).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.message).toBe('failed for [email] at /otmetka/[token]');
    expect(out.transaction).toBe('/klubove/pokana/[token]');
    expect(out.request).toEqual({
      url: 'https://pops.bg/sedmitsata/otpisvane/[token]',
      headers: { Referer: 'https://pops.bg/pasport/[token]', 'User-Agent': 'x' },
    });
    expect(out.exception?.values?.[0]?.value).toBe('code [token] for [email]');
    expect(out.breadcrumbs).toEqual([
      { category: 'navigation', data: { from: '/', to: '/s/[token]' } },
    ]);
    // The input is not mutated.
    expect(event.user?.email).toBe('ivan@example.org');
  });

  it('the error monitor wires both hooks into the SDK', () => {
    const source = readFileSync(
      join(__dirname, '..', 'components', 'monitoring', 'error-monitor.tsx'),
      'utf8',
    );
    expect(source).toMatch(/beforeSend: \(event\) => scrubEvent\(event\)/);
    expect(source).toMatch(/beforeBreadcrumb: \(breadcrumb\) => scrubBreadcrumb\(breadcrumb\)/);
    expect(source).toMatch(/sendDefaultPii: false/);
  });
});
