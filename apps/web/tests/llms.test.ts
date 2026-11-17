import type { AbstractIntlMessages } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { GET as englishFile } from '../app/[locale]/llms.txt/route';
import { GET as bulgarianFile } from '../app/llms.txt/route';
import { buildLlmsText, llmsPath } from '../lib/llms';
import { siteUrl } from '../lib/seo';

// The real catalogues through the real translator: a missing key or a broken
// placeholder in the `Llms` namespace fails here, not as a 500 for a crawler.
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const bg = (await import('../messages/bg.json')).default;
  const en = (await import('../messages/en.json')).default;
  return {
    getTranslations: ({ locale, namespace }: { locale: string; namespace: string }) => {
      const messages: AbstractIntlMessages = locale === 'en' ? en : bg;
      return Promise.resolve(createTranslator({ locale, messages, namespace }));
    },
  };
});

/**
 * /llms.txt (lib/llms.ts): the site described for a language model. The shape
 * is the llmstxt.org one, and it is asserted because a model parses it — one
 * H1, a quoted summary, then H2 sections holding nothing but links.
 */

const ORIGIN = siteUrl();
const links = (text: string) => [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? '');

describe('the Bulgarian file', () => {
  it('has one title, a quoted summary and three link sections', async () => {
    const text = await buildLlmsText('bg', { clubs: false });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^# \S/);
    expect(lines.filter((line) => line.startsWith('# '))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('> '))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('## '))).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/\{[a-z]+\}/); // no unfilled placeholder
  });

  it('links only to this site, by absolute address', async () => {
    const found = links(await buildLlmsText('bg', { clubs: true }));
    expect(found.length).toBeGreaterThan(8);
    for (const url of found) expect(url.startsWith(`${ORIGIN}/`), url).toBe(true);
  });

  it('puts the licence and the credit line beside the data', async () => {
    const text = await buildLlmsText('bg', { clubs: false });
    expect(text).toContain('ODbL');
    expect(text).toContain('© OpenStreetMap contributors + POPS community');
    expect(links(text)).toContain(`${ORIGIN}/api/opendata/v1/facilities`);
    expect(links(text)).toContain(`${ORIGIN}/danni/litsenz`);
  });

  it('mentions the clubs pages only while they exist', async () => {
    const off = await buildLlmsText('bg', { clubs: false });
    const on = await buildLlmsText('bg', { clubs: true });
    expect(links(off).some((url) => url.includes('klubove'))).toBe(false);
    expect(links(on)).toEqual(
      expect.arrayContaining([`${ORIGIN}/klubove`, `${ORIGIN}/za-klubove`]),
    );
    // One more statement and two more links: the paid platform is a fact
    // about the site only while it is sold.
    expect(on.split('\n').length).toBe(off.split('\n').length + 3);
  });
});

describe('the English file', () => {
  it('links to the English pages and back to the Bulgarian file', async () => {
    const found = links(await buildLlmsText('en', { clubs: false }));
    expect(found).toContain(`${ORIGIN}/en/karta`);
    expect(found).toContain(`${ORIGIN}/en/danni`);
    expect(found).toContain(`${ORIGIN}${llmsPath('bg')}`);
    expect(found).not.toContain(`${ORIGIN}/karta`);
  });

  it('is linked from the Bulgarian one', async () => {
    expect(links(await buildLlmsText('bg', { clubs: false }))).toContain(`${ORIGIN}/en/llms.txt`);
  });
});

describe('the routes', () => {
  const request = new Request('http://localhost/llms.txt');
  const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

  it('serve Markdown that stays out of search results', async () => {
    const response = await bulgarianFile();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(await response.text()).toMatch(/^# /);
  });

  it('answer under a prefix for English only', async () => {
    expect((await englishFile(request, params('en'))).status).toBe(200);
    // /bg/llms.txt would be a second copy of /llms.txt; anything else is not a locale.
    expect((await englishFile(request, params('bg'))).status).toBe(404);
    expect((await englishFile(request, params('robots'))).status).toBe(404);
  });
});
