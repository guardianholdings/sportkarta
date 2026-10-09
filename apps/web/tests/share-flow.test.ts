import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildShare } from '@sportkarta/lib/share';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  attemptShare,
  captionWithLink,
  isShareCancel,
  type ShareNavigator,
} from '../components/share/share-flow';
import { facilitySharePlace } from '../lib/share/facility-place';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The share button's OS-sheet attempt. Two audited defects:
 *   - a phone that can share files got the story image and a caption with NO
 *     link, so the share could not bring anyone back to the site;
 *   - any rejection was swallowed as a cancel, so when the story fetch outlived
 *     the tap's user activation, share() failed with NotAllowedError and the
 *     button silently did nothing.
 */

const PAYLOAD = buildShare({
  kind: 'facility',
  locale: 'bg',
  origin: 'https://example.test',
  page: '/obekt/borisova-gradina',
  ref: 'borisova-gradina',
  text: 'Борисова градина — свободна спортна площадка в POPS.',
});

const FILE = new File([new Uint8Array([1, 2, 3])], 'pops-facility.png', { type: 'image/png' });

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function fakeNav(opts: { canShareFiles?: boolean; reject?: Error } = {}) {
  const calls: ShareData[] = [];
  const nav: ShareNavigator = {
    share: vi.fn((data: ShareData) => {
      calls.push(data);
      return opts.reject ? Promise.reject(opts.reject) : Promise.resolve();
    }),
    canShare: () => opts.canShareFiles ?? true,
  };
  return { nav, calls };
}

describe('attemptShare', () => {
  it('puts the link in the caption of a FILE share', async () => {
    const { nav, calls } = fakeNav();
    const outcome = await attemptShare(nav, PAYLOAD, () => Promise.resolve(FILE));
    expect(outcome).toBe('shared');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.files).toEqual([FILE]);
    expect(calls[0]?.text).toContain(PAYLOAD.url);
    expect(calls[0]?.text).toBe(captionWithLink(PAYLOAD));
  });

  it('falls back to text + url when the browser will not take the file', async () => {
    const { nav, calls } = fakeNav({ canShareFiles: false });
    await attemptShare(nav, PAYLOAD, () => Promise.resolve(FILE));
    expect(calls[0]).toEqual({ text: PAYLOAD.text, url: PAYLOAD.url });
  });

  it('shares without the image rather than wait out the tap’s activation', async () => {
    vi.useFakeTimers();
    try {
      const { nav, calls } = fakeNav();
      const never = new Promise<File | null>(() => undefined);
      const pending = attemptShare(nav, PAYLOAD, () => never, 2500);
      await vi.advanceTimersByTimeAsync(2500);
      expect(await pending).toBe('shared');
      expect(calls[0]).toEqual({ text: PAYLOAD.text, url: PAYLOAD.url });
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the panel when the share is REFUSED (lapsed activation)', async () => {
    const { nav } = fakeNav({ reject: domError('NotAllowedError') });
    expect(await attemptShare(nav, PAYLOAD, () => Promise.resolve(FILE))).toBe('panel');
  });

  it('stays silent when the member cancels the sheet', async () => {
    const { nav } = fakeNav({ reject: domError('AbortError') });
    expect(await attemptShare(nav, PAYLOAD, () => Promise.resolve(FILE))).toBe('cancelled');
  });

  it('opens the panel when there is no share API at all', async () => {
    expect(await attemptShare(null, PAYLOAD, () => Promise.resolve(FILE))).toBe('panel');
    expect(await attemptShare({}, PAYLOAD, () => Promise.resolve(FILE))).toBe('panel');
  });

  it('does not fetch a story the payload does not have', async () => {
    const { nav } = fakeNav();
    const storyFile = vi.fn(() => Promise.resolve(FILE));
    await attemptShare(nav, { ...PAYLOAD, storyPath: null }, storyFile);
    expect(storyFile).not.toHaveBeenCalled();
  });
});

describe('isShareCancel', () => {
  it('recognises only AbortError', () => {
    expect(isShareCancel(domError('AbortError'))).toBe(true);
    expect(isShareCancel(domError('NotAllowedError'))).toBe(false);
    expect(isShareCancel('AbortError')).toBe(false);
    expect(isShareCancel(null)).toBe(false);
  });
});

describe('the address printed on story images', () => {
  function walk(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) walk(child, out);
    }
    return out;
  }

  it('is never a domain written into the copy of a shared artifact', () => {
    // «pops.bg» did not resolve when it was printed on every shared story.
    for (const messages of [bg, en]) {
      const shared = [messages.Story, messages.ShareSheet, messages.Share, messages.Og];
      for (const text of walk(shared)) expect(text).not.toMatch(/pops\.bg/i);
    }
  });

  it('is filled in from the configured site', () => {
    for (const [locale, messages] of [
      ['bg', bg],
      ['en', en],
    ] as const) {
      const t = createTranslator({ locale, messages, namespace: 'Story' });
      expect(t('callToAction', { site: 'example.test' })).toContain('example.test');
      expect(t('session.callToAction', { site: 'example.test' })).toContain('example.test');
    }
  });

  it('is the configured origin’s host, without the scheme', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.test/');
    try {
      const { siteHost, siteUrl } = await import('../lib/seo');
      expect(siteUrl()).toBe('https://example.test');
      expect(siteHost()).toBe('example.test');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('keeps a port, so a bare-IP deployment prints an address that works', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://203.0.113.7:8080');
    try {
      const { siteHost } = await import('../lib/seo');
      expect(siteHost()).toBe('203.0.113.7:8080');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('never throws on a malformed origin — a story is not worth a 500', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'example.test');
    try {
      const { siteHost } = await import('../lib/seo');
      expect(siteHost()).toBe('example.test');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('is passed by every story route that prints the call to action', () => {
    const ogRoot = path.join(__dirname, '..', 'app', 'og');
    const routes: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) visit(full);
        else if (name === 'route.tsx') routes.push(full);
      }
    };
    visit(ogRoot);
    const offenders = routes.filter((file) => {
      const src = readFileSync(file, 'utf8');
      return /tStory\('(?:session\.)?callToAction'\)/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * L05, 2026-10-09: seven replies under an Instagram Reel read
 * „way-313548695 — свободна спортна площадка в POPS.“ The facility share text
 * fell back to the slug, and an unnamed place's slug is its map ID.
 */
describe('the facility share text', () => {
  const MAP_ID = /\b(?:way|node|relation)-\d+/;
  const unnamed = {
    name: null,
    municipalityName: 'София',
    quarter: null,
    slug: 'way-313548695',
  };

  for (const [locale, messages] of [
    ['bg', bg],
    ['en', en],
  ] as const) {
    const t = createTranslator({ locale, messages });
    const shareText = (facility: Parameters<typeof facilitySharePlace>[0]) =>
      t('ShareSheet.textFacility', { place: facilitySharePlace(facility, t('Facility.unnamed')) });

    it(`never names an unnamed place by its slug or map ID (${locale})`, () => {
      const text = shareText(unnamed);
      expect(text).not.toContain(unnamed.slug);
      expect(text).not.toMatch(MAP_ID);
      // It names it the way the page does, plus where it is.
      expect(text).toContain(t('Facility.unnamed'));
      expect(text).toContain('София');
    });

    it(`falls back to the quarter, then to the bare label (${locale})`, () => {
      expect(shareText({ ...unnamed, municipalityName: null, quarter: 'Лозенец' })).toContain(
        `${t('Facility.unnamed')}, Лозенец`,
      );
      const bare = shareText({ ...unnamed, municipalityName: null, quarter: null });
      expect(bare.startsWith(`${t('Facility.unnamed')} `)).toBe(true);
      expect(bare).not.toMatch(MAP_ID);
    });

    it(`keeps a real name exactly as it is (${locale})`, () => {
      const text = shareText({ ...unnamed, name: 'Борисова градина' });
      expect(text.startsWith('Борисова градина — ')).toBe(true);
      expect(text).not.toContain('София');
    });

    it(`treats a blank name as no name (${locale})`, () => {
      expect(shareText({ ...unnamed, name: '  ' })).toContain(t('Facility.unnamed'));
    });
  }

  it('is built through facilitySharePlace on the facility page, never from the slug', () => {
    const page = readFileSync(
      path.join(__dirname, '..', 'app', '[locale]', 'obekt', '[slug]', 'page.tsx'),
      'utf8',
    );
    expect(page).toMatch(/textFacility', \{\s*place: facilitySharePlace\(/);
  });

  it('has no name-or-slug fallback anywhere a share, OG title or alt text is built', () => {
    const roots = [path.join(__dirname, '..', 'app'), path.join(__dirname, '..', 'components')];
    const files: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        // The admin tools show a slug on purpose: it is how a moderator tells
        // two unnamed import candidates apart. Nothing there is shared.
        if (statSync(full).isDirectory()) {
          if (name !== 'admin') visit(full);
        } else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    roots.forEach(visit);
    const offenders = files.filter((file) =>
      /\bname\s*\?\?\s*(?:[\w.]+\.)?slug\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
