import { META_PIXEL_SCRIPT_URL, gaScriptUrl } from '@sportkarta/lib/clubs';
import { describe, expect, it, vi } from 'vitest';

import {
  clubTrackingRunning,
  landedHere,
  reloadToStart,
  startClubTracking,
  withdrawClubTracking,
  type ClubTrackingStart,
  type FbQueue,
  type TrackingHost,
} from '@/lib/club-tracking-runtime';

/**
 * What a club's pixels do once a visitor has accepted (wave H2), against a
 * stand-in for `window`: they start once, with Meta's automatic events off
 * and every event addressed to this club's own ids; the document they run in
 * never shows another address (links load in full, back/forward and route
 * changes reload, with the vendors switched off first); and withdrawing
 * switches them off before it clears their cookies.
 */

const GA = 'G-AB12CD34';
const META = '123456789012';

function fakeHost(
  href: string,
  options: {
    landed?: string;
    referrer?: string;
    cookies?: string[];
    session?: Map<string, string>;
  } = {},
) {
  const url = new URL(href);
  const scripts: string[] = [];
  const cookieWrites: { value: string; vendorsOff: boolean }[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const session = options.session ?? new Map<string, string>();
  const reload = vi.fn();
  const move = (next: string | URL | null | undefined) => {
    if (next !== null && next !== undefined) url.href = new URL(String(next), url.href).href;
  };
  const host: TrackingHost & Record<string, unknown> = {
    location: {
      get href() {
        return url.href;
      },
      get origin() {
        return url.origin;
      },
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
      get hostname() {
        return url.hostname;
      },
      reload,
    },
    history: {
      state: { kept: true },
      pushState: (_data, _unused, next) => move(next),
      replaceState: (_data, _unused, next) => move(next),
    },
    document: {
      referrer: options.referrer ?? '',
      get cookie() {
        return (options.cookies ?? []).join('; ');
      },
      set cookie(value: string) {
        cookieWrites.push({
          value,
          vendorsOff:
            host[`ga-disable-${GA}`] === true &&
            (host.fbq?.queue ?? []).some((call) => JSON.stringify(call) === '["consent","revoke"]'),
        });
      },
      head: { appendChild: (node: never) => scripts.push((node as { src: string }).src) },
      createElement: () => ({ async: false, src: '' }),
      querySelector: (selector: string) =>
        scripts.some((src) => selector === `script[src="${src}"]`) ? {} : null,
    },
    performance: { getEntriesByType: () => [{ name: options.landed ?? href }] },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    },
    addEventListener: (type: string, listener: (event: never) => void) => {
      (listeners[type] ??= []).push(listener as (event: unknown) => void);
    },
  };
  return { host, url, scripts, cookieWrites, listeners, session, reload };
}

const start = (overrides: Partial<ClubTrackingStart> = {}): ClubTrackingStart => ({
  gaId: GA,
  metaId: META,
  cookiePath: '/klub/zala',
  leadId: null,
  hideParams: [],
  ...overrides,
});

function gtagCalls(host: TrackingHost): unknown[][] {
  return (host.dataLayer ?? []).map((args) => Array.from(args as ArrayLike<unknown>));
}

function fbqCalls(host: TrackingHost): unknown[][] {
  return (host.fbq?.queue ?? []) as unknown[][];
}

function click(
  listeners: Record<string, ((event: unknown) => void)[]>,
  anchor: { href: string; target?: string; download?: boolean },
  keys: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {},
) {
  const stopPropagation = vi.fn();
  const element = {
    href: anchor.href,
    target: anchor.target ?? '',
    hasAttribute: (name: string) => name === 'download' && anchor.download === true,
  };
  for (const listener of listeners.click ?? []) {
    listener({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...keys,
      target: { closest: () => element },
      stopPropagation,
    });
  }
  return stopPropagation;
}

describe('club tracking in the browser (wave H2)', () => {
  it('starts once, privately configured, every event addressed to this club', () => {
    const { host, scripts } = fakeHost('https://pops.test/klub/zala');
    startClubTracking(host, start());
    startClubTracking(host, start());
    expect(clubTrackingRunning(host)).toBe(true);
    expect(scripts).toEqual([gaScriptUrl(GA), META_PIXEL_SCRIPT_URL]);

    expect(gtagCalls(host).find((call) => call[0] === 'config')).toEqual([
      'config',
      GA,
      {
        cookie_path: '/klub/zala',
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      },
    ]);
    expect(fbqCalls(host)).toEqual([
      ['set', 'autoConfig', false, META],
      ['init', META],
      ['trackSingle', META, 'PageView'],
    ]);
    expect((host.fbq as FbQueue).disablePushState).toBe(true);
  });

  it('reports an inquiry once, to this club only', () => {
    const session = new Map<string, string>();
    const first = fakeHost('https://pops.test/klub/zala/zapitvane?rezultat=sent', { session });
    startClubTracking(first.host, start({ leadId: 'thread-1' }));
    expect(gtagCalls(first.host)).toContainEqual(['event', 'generate_lead', { send_to: GA }]);
    expect(fbqCalls(first.host)).toContainEqual(['trackSingle', META, 'Lead']);

    // The same confirmation reloaded: a page view, no second Lead.
    const again = fakeHost('https://pops.test/klub/zala/zapitvane?rezultat=sent', { session });
    startClubTracking(again.host, start({ leadId: 'thread-1' }));
    expect(gtagCalls(again.host).some((call) => call[1] === 'generate_lead')).toBe(false);
    expect(fbqCalls(again.host)).not.toContainEqual(['trackSingle', META, 'Lead']);
  });

  it('takes hidden parameters out of the address before anything loads', () => {
    const { host, url, reload } = fakeHost(
      'https://pops.test/klub/zala/zapitvane?rezultat=sent&razgovor=abc#top',
    );
    startClubTracking(host, start({ hideParams: ['razgovor'] }));
    expect(url.href).toBe('https://pops.test/klub/zala/zapitvane?rezultat=sent#top');
    expect(reload).not.toHaveBeenCalled();
  });

  it('cuts a same-site referrer to its path; another site’s is left alone', () => {
    const fromMap = fakeHost('https://pops.test/klub/zala', {
      referrer: 'https://pops.test/karta?lat=42.69&lng=23.32&z=14',
    });
    startClubTracking(fromMap.host, start());
    expect(fromMap.host.document.referrer).toBe('https://pops.test/karta');

    const fromSearch = fakeHost('https://pops.test/klub/zala', {
      referrer: 'https://www.google.com/',
    });
    startClubTracking(fromSearch.host, start());
    expect(fromSearch.host.document.referrer).toBe('https://www.google.com/');
  });

  it('turns every link off the page into a full load', () => {
    const { host, listeners } = fakeHost('https://pops.test/klub/zala');
    startClubTracking(host, start());
    // In-app routing never sees these: the browser loads the page itself.
    expect(click(listeners, { href: 'https://pops.test/karta' })).toHaveBeenCalled();
    expect(click(listeners, { href: 'https://pops.test/klub/zala/az' })).toHaveBeenCalled();
    expect(click(listeners, { href: 'https://pops.test/klub/drug' })).toHaveBeenCalled();
    // A jump within the page, a new tab, a download: untouched.
    expect(click(listeners, { href: 'https://pops.test/klub/zala#grafik' })).not.toHaveBeenCalled();
    expect(
      click(listeners, { href: 'https://pops.test/karta', target: '_blank' }),
    ).not.toHaveBeenCalled();
    expect(
      click(listeners, { href: 'https://pops.test/karta' }, { metaKey: true }),
    ).not.toHaveBeenCalled();
    expect(
      click(listeners, { href: 'https://pops.test/file.ics', download: true }),
    ).not.toHaveBeenCalled();
  });

  it('reloads on back/forward to another address', () => {
    const { host, url, listeners, reload } = fakeHost('https://pops.test/klub/zala');
    startClubTracking(host, start());
    const stop = vi.fn();
    url.href = 'https://pops.test/klub/zala#grafik';
    for (const listener of listeners.popstate ?? []) listener({ stopImmediatePropagation: stop });
    expect(reload).not.toHaveBeenCalled();

    url.href = 'https://pops.test/karta?lat=42.69&lng=23.32';
    for (const listener of listeners.popstate ?? []) listener({ stopImmediatePropagation: stop });
    expect(stop).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('switches the vendors off before an in-app route change, then reloads', () => {
    const { host, url, reload } = fakeHost('https://pops.test/klub/zala');
    startClubTracking(host, start());
    host.history.replaceState({ scroll: 1 }, '', '/klub/zala');
    host.history.pushState(null, '', null);
    expect(reload).not.toHaveBeenCalled();
    expect(host[`ga-disable-${GA}`]).toBeUndefined();

    host.history.pushState(null, '', '/vhod?next=%2Fklub%2Fzala');
    expect(host[`ga-disable-${GA}`]).toBe(true);
    expect(fbqCalls(host)).toContainEqual(['consent', 'revoke']);
    expect(url.pathname).toBe('/vhod');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('withdraws: vendors off first, then every cookie on every club path', () => {
    const { host, cookieWrites, reload } = fakeHost('https://pops.test/en/klub/zala', {
      cookies: ['_ga=GA1.1.1', '_gcl_au=1.1', 'pops_session=keep'],
    });
    startClubTracking(host, start({ cookiePath: '/en/klub/zala' }));
    withdrawClubTracking(host, GA, ['/klub/zala', '/en/klub/zala']);

    expect(cookieWrites.length).toBeGreaterThan(0);
    expect(cookieWrites.every((write) => write.vendorsOff)).toBe(true);
    const written = cookieWrites.map((write) => write.value);
    for (const expected of [
      '_ga=; Max-Age=0; path=/',
      '_ga_AB12CD34=; Max-Age=0; path=/klub/zala',
      '_ga_AB12CD34=; Max-Age=0; path=/en/klub/zala',
      '_fbp=; Max-Age=0; path=/; domain=.pops.test',
      '_gcl_au=; Max-Age=0; path=/en/klub/zala',
    ]) {
      expect(written).toContain(expected);
    }
    expect(written.some((value) => value.startsWith('pops_session='))).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('a decline with nothing running clears leftovers without a reload', () => {
    const { host, cookieWrites, reload } = fakeHost('https://pops.test/klub/zala', {
      cookies: ['_ga=GA1.1.1'],
    });
    withdrawClubTracking(host, GA, ['/klub/zala', '/en/klub/zala']);
    expect(cookieWrites.map((write) => write.value)).toContain('_ga=; Max-Age=0; path=/');
    expect(reload).not.toHaveBeenCalled();
  });

  it('starts only in a document loaded at this address, reloading once to get one', () => {
    const arrived = fakeHost('https://pops.test/klub/zala', {
      landed: 'https://pops.test/klubove',
    });
    expect(landedHere(arrived.host)).toBe(false);
    expect(reloadToStart(arrived.host)).toBe(true);
    // If the reload did not land here either, stay off rather than loop.
    expect(reloadToStart(arrived.host)).toBe(false);
    expect(arrived.reload).toHaveBeenCalledOnce();

    const loaded = fakeHost('https://pops.test/klub/zala?rezultat=sent', {
      landed: 'https://pops.test/klub/zala',
      session: arrived.session,
    });
    expect(landedHere(loaded.host)).toBe(true);
    startClubTracking(loaded.host, start());
    // Started: a later in-app arrival may reload again.
    expect(loaded.session.size).toBe(0);
  });
});
