import type { AbstractIntlMessages } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public card routes answer a junk id with 404, not 500.
 *
 * A session id reaches SQL as `::uuid`, and Postgres answers a malformed one
 * with a cast ERROR rather than an empty result — so before the guard,
 * `/og/bg/sesiya/not-a-uuid/card.png` was a 500 and an error-log line that any
 * scanner could mint by the thousand, burying the real errors the operator
 * reads the log for. occurrenceView is mocked to throw exactly as Postgres
 * would, and the guard must keep it from being called at all.
 */

const occurrenceView = vi.fn();

vi.mock('@/lib/sessions/occurrence', () => ({
  occurrenceView: (...args: unknown[]) => occurrenceView(...args) as unknown,
}));

// Real catalogue strings through next-intl's standalone translator: the route
// calls getTranslations({ locale, namespace }) exactly like this.
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

const JUNK = ['not-a-uuid', '1', "x' OR 1=1 --", '00000000-0000-0000-0000-00000000000'];
const VALID = '00000000-0000-4000-8000-000000000000';

beforeEach(() => {
  occurrenceView.mockReset();
  occurrenceView.mockImplementation(() => {
    throw new Error('invalid input syntax for type uuid');
  });
});

describe('session link-preview card', () => {
  it.each(JUNK)('404s %j without querying', async (slug) => {
    const { GET } = await import('../app/og/[locale]/[kind]/[slug]/card.png/route');
    const res = await GET(new Request('http://localhost/og'), {
      params: Promise.resolve({ locale: 'bg', kind: 'sesiya', slug }),
    });
    expect(res.status).toBe(404);
    expect(occurrenceView).not.toHaveBeenCalled();
  });

  it('still looks up a well-formed id, and 404s one that does not exist', async () => {
    occurrenceView.mockReset();
    occurrenceView.mockResolvedValue(null);
    const { GET } = await import('../app/og/[locale]/[kind]/[slug]/card.png/route');
    const res = await GET(new Request('http://localhost/og'), {
      params: Promise.resolve({ locale: 'bg', kind: 'sesiya', slug: VALID }),
    });
    expect(res.status).toBe(404);
    expect(occurrenceView).toHaveBeenCalledWith(VALID, null);
  });
});

describe('session story image', () => {
  it.each(JUNK)('404s %j without querying', async (slug) => {
    const { GET } = await import('../app/og/[locale]/story/[kind]/[slug]/story.png/route');
    const res = await GET(new Request('http://localhost/og'), {
      params: Promise.resolve({ locale: 'bg', kind: 'session', slug }),
    });
    expect(res.status).toBe(404);
    expect(occurrenceView).not.toHaveBeenCalled();
  });
});

describe('site-wide card', () => {
  it.each(['bg', 'en'])(
    'renders the %s brand card as a cacheable 1200x630 PNG',
    { timeout: 30_000 },
    async (locale) => {
      const { GET } = await import('../app/og/[locale]/site/card.png/route');
      const res = (await GET(new Request('http://localhost/og'), {
        params: Promise.resolve({ locale }),
      })) as unknown as Response;
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control') ?? '').toContain('public');
      const png = Buffer.from(await res.arrayBuffer());
      expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(630);
    },
  );
});
