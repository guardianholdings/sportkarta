import { describe, expect, it } from 'vitest';

import {
  buildShare,
  cardPath,
  carriesCaption,
  formatKm,
  formatMinutes,
  isPersonScoped,
  joinsTextAndUrl,
  localePath,
  NETWORKS,
  networkUrl,
  PERSON_SCOPED_KINDS,
  SHARE_KINDS,
  storyPath,
  type ShareKind,
} from './index.js';

const ORIGIN = 'https://pops.bg';

describe('the share catalogue', () => {
  it('covers every moment the product can talk about', () => {
    expect(SHARE_KINDS).toEqual([
      'training',
      'week',
      'badge',
      'passport',
      'division',
      'legend',
      'facility',
      'session',
      'campaign',
    ]);
  });

  /**
   * The privacy switch is a property of the KIND, not of a caller remembering.
   * Everything that names the member is person-scoped; everything that names a
   * place, a session or a campaign is public.
   */
  it('marks exactly the member-naming kinds as person-scoped', () => {
    expect([...PERSON_SCOPED_KINDS].sort()).toEqual([
      'badge',
      'division',
      'passport',
      'training',
      'week',
    ]);
    for (const kind of ['legend', 'facility', 'session', 'campaign'] as ShareKind[]) {
      expect(isPersonScoped(kind), kind).toBe(false);
    }
  });
});

describe('storyPath', () => {
  it('routes person-scoped stories under /og/lichen and public ones under /og', () => {
    expect(storyPath({ kind: 'passport', locale: 'bg' })).toBe('/og/lichen/bg/passport/story.png');
    expect(storyPath({ kind: 'training', locale: 'bg', ref: 'abc' })).toBe(
      '/og/lichen/bg/training/abc/story.png',
    );
    expect(storyPath({ kind: 'facility', locale: 'bg', ref: 'yuzhen-park' })).toBe(
      '/og/bg/story/facility/yuzhen-park/story.png',
    );
  });

  /**
   * Both are silent failures if broken. The dot makes middleware skip the path
   * (otherwise every fetch 307s); the locale segment exists BECAUSE of that dot,
   * since next-intl then never resolves a request locale and every story would
   * render in Bulgarian — including one shared from an /en page.
   */
  it('always ends in a dotted segment and always carries a locale segment', () => {
    for (const kind of SHARE_KINDS) {
      const path = storyPath({ kind, locale: 'en', ref: 'ref' });
      expect(path, kind).not.toBeNull();
      expect(path?.endsWith('/story.png'), kind).toBe(true);
      expect(path?.split('/').includes('en'), kind).toBe(true);
    }
  });

  it('falls back to bg for an unknown locale rather than minting a third tree', () => {
    expect(storyPath({ kind: 'passport', locale: 'de' })).toBe('/og/lichen/bg/passport/story.png');
  });

  it('returns null when a kind needs a ref and has none', () => {
    expect(storyPath({ kind: 'training', locale: 'bg' })).toBeNull();
    expect(storyPath({ kind: 'badge', locale: 'bg', ref: '  ' })).toBeNull();
    expect(storyPath({ kind: 'facility', locale: 'bg' })).toBeNull();
    // …and never for the three that describe "my current state".
    expect(storyPath({ kind: 'passport', locale: 'bg' })).not.toBeNull();
    expect(storyPath({ kind: 'week', locale: 'bg' })).not.toBeNull();
    expect(storyPath({ kind: 'division', locale: 'bg' })).not.toBeNull();
  });

  it('escapes a ref rather than letting it build the path', () => {
    const path = storyPath({ kind: 'facility', locale: 'bg', ref: '../../admin' });
    expect(path).not.toContain('../');
    expect(path).toContain('..%2F..%2Fadmin');
  });
});

describe('cardPath', () => {
  it('exists only for public kinds — a person-scoped card is never scraper-fetchable', () => {
    for (const kind of PERSON_SCOPED_KINDS) {
      expect(cardPath({ kind, locale: 'bg', ref: 'x' }), kind).toBeNull();
    }
    expect(cardPath({ kind: 'facility', locale: 'bg', ref: 'park' })).toBe(
      '/og/bg/obekt/park/card.png',
    );
    expect(cardPath({ kind: 'session', locale: 'bg', ref: 's1' })).toBe(
      '/og/bg/sesiya/s1/card.png',
    );
  });
});

describe('networkUrl', () => {
  const TEXT = '5 км тичане · СпортКарта';
  const URL = 'https://pops.bg/trenirovki';

  it('produces an absolute URL for every network, with nothing unescaped', () => {
    for (const network of NETWORKS) {
      const url = networkUrl(network, TEXT, URL);
      expect(url, network).toMatch(/^(https:\/\/|viber:\/\/)/);
      // A raw space, newline or # in a query string truncates it silently.
      expect(url.includes(' '), network).toBe(false);
      expect(url.includes('\n'), network).toBe(false);
    }
  });

  it('sends Viber and WhatsApp one blob, and Telegram and X separate fields', () => {
    expect(joinsTextAndUrl('viber')).toBe(true);
    expect(joinsTextAndUrl('whatsapp')).toBe(true);
    expect(joinsTextAndUrl('telegram')).toBe(false);
    expect(networkUrl('viber', 'a', 'b')).toBe('viber://forward?text=a%0Ab');
    expect(networkUrl('telegram', 'a', 'b')).toBe('https://t.me/share/url?url=b&text=a');
  });

  /**
   * Facebook has ignored `quote` since 2017, so passing the caption would drop
   * it silently. The UI says so rather than pretending otherwise — a share that
   * quietly loses its words looks like the product's bug.
   */
  it('knows Facebook drops the caption', () => {
    expect(carriesCaption('facebook')).toBe(false);
    expect(networkUrl('facebook', 'ignored', 'https://x.test/a')).toBe(
      'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fx.test%2Fa',
    );
    for (const network of NETWORKS.filter((n) => n !== 'facebook')) {
      expect(carriesCaption(network), network).toBe(true);
    }
  });

  it('puts Viber and Facebook first — the country order, not the world order', () => {
    expect(NETWORKS[0]).toBe('viber');
    expect(NETWORKS[1]).toBe('facebook');
  });
});

describe('buildShare', () => {
  /**
   * EXACT KEYS. This object crosses into a client component and then into the OS
   * share sheet, so it is the last place a field can be added unnoticed — the
   * same guard `PassportShare` carries, and the one that caught `weeksAtRisk`
   * leaking in phase 4.
   */
  it('has exactly these keys and no others', () => {
    const payload = buildShare({
      kind: 'training',
      locale: 'bg',
      origin: ORIGIN,
      page: '/trenirovki',
      text: 'x',
      ref: 'abc',
    });
    expect(Object.keys(payload).sort()).toEqual([
      'cardPath',
      'kind',
      'personScoped',
      'storyPath',
      'text',
      'url',
    ]);
  });

  it('carries no id, timestamp or handle of its own', () => {
    const payload = buildShare({
      kind: 'passport',
      locale: 'bg',
      origin: ORIGIN,
      page: '/pasport/abcdef',
      text: 'x',
    });
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain('userId');
    expect(blob).not.toContain('createdAt');
    expect(blob).not.toContain('email');
  });

  it('normalises a trailing slash on the origin and a missing one on the page', () => {
    const payload = buildShare({
      kind: 'facility',
      locale: 'bg',
      origin: `${ORIGIN}/`,
      page: 'obekt/park',
      text: 'x',
      ref: 'park',
    });
    expect(payload.url).toBe(`${ORIGIN}/obekt/park`);
  });

  it('links an English share to the English page', () => {
    // The site serves bg unprefixed and en under /en; an English caption used
    // to send its reader to the Bulgarian page.
    const en = buildShare({
      kind: 'session',
      locale: 'en',
      origin: ORIGIN,
      page: '/sesiya/s1',
      text: 'x',
      ref: 's1',
    });
    expect(en.url).toBe(`${ORIGIN}/en/sesiya/s1`);
    const bg = buildShare({
      kind: 'session',
      locale: 'bg',
      origin: ORIGIN,
      page: '/sesiya/s1',
      text: 'x',
      ref: 's1',
    });
    expect(bg.url).toBe(`${ORIGIN}/sesiya/s1`);
  });

  it('prefixes only English, and the home page without a trailing slash', () => {
    expect(localePath('/', 'en')).toBe('/en');
    expect(localePath('/klasirane', 'en')).toBe('/en/klasirane');
    expect(localePath('/klasirane', 'bg')).toBe('/klasirane');
    expect(localePath('/klasirane', 'de')).toBe('/klasirane');
  });

  it('flags person-scoped kinds so the caller cannot forget the no-store rule', () => {
    expect(
      buildShare({ kind: 'week', locale: 'bg', origin: ORIGIN, page: '/', text: 'x' }).personScoped,
    ).toBe(true);
    expect(
      buildShare({ kind: 'facility', locale: 'bg', origin: ORIGIN, page: '/', text: 'x', ref: 'p' })
        .personScoped,
    ).toBe(false);
  });
});

describe('formatting helpers', () => {
  it('prints km to one decimal and treats absent or zero distance as absent', () => {
    expect(formatKm(5000, 'en')).toBe('5.0');
    expect(formatKm(5450, 'en')).toBe('5.5');
    expect(formatKm(null, 'bg')).toBeNull();
    expect(formatKm(0, 'bg')).toBeNull();
    expect(formatKm(Number.NaN, 'bg')).toBeNull();
  });

  it('writes the decimal the way the reader does — a comma in Bulgarian', () => {
    // A Bulgarian caption used to read «5.2 км».
    expect(formatKm(5200, 'bg')).toBe('5,2');
    expect(formatKm(5200, 'en')).toBe('5.2');
    expect(formatKm(12_345, 'bg')).toBe('12,3');
  });

  it('rounds seconds to whole minutes and never goes negative', () => {
    expect(formatMinutes(3120)).toBe(52);
    expect(formatMinutes(29)).toBe(0);
    expect(formatMinutes(-100)).toBe(0);
  });
});
