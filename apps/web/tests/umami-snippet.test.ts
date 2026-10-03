import { runInNewContext } from 'node:vm';

import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import {
  BEFORE_SEND_GLOBAL,
  CAMPAIGN_HOOK_SCRIPT,
  UmamiAnalytics,
} from '@/components/analytics/umami';

type Payload = Record<string, unknown>;
type Hook = (type: string, payload: Payload) => Payload;

function scripts(): Record<string, unknown>[] {
  const element = UmamiAnalytics({ src: 'https://umami.pops.test/script.js', websiteId: 'w' });
  const children = (element.props as { children: ReactElement[] }).children;
  return children.map((child) => child.props as Record<string, unknown>);
}

/** Runs the shipped inline script for a visit that landed on `search`. */
function hookFor(search: string): Hook {
  const win: Record<string, unknown> = { location: { search, href: `https://pops.bg/${search}` } };
  runInNewContext(CAMPAIGN_HOOK_SCRIPT, { window: win, URL, URLSearchParams });
  return win[BEFORE_SEND_GLOBAL] as Hook;
}

/**
 * The analytics snippet must not report query strings (pre-launch audit,
 * legal cluster). The map keeps its centre in `?lat=…&lng=…`, which after
 * "locate me" is the visitor's own position to about a metre, and Umami's
 * tracker reports every history change — so without the flag the analytics
 * database would collect positions that /privacy says never leave the browser.
 * The one exception is the campaign tags (utm_*) on a visit's landing pageview.
 */
describe('UmamiAnalytics', () => {
  it('excludes the query string from every tracked URL', () => {
    const tracker = scripts().find((props) => props.src);
    expect(tracker?.['data-exclude-search']).toBe('true');
    expect(tracker?.['data-website-id']).toBe('w');
    expect(tracker?.['data-before-send']).toBe(BEFORE_SEND_GLOBAL);
  });

  it('installs the campaign hook before the deferred tracker', () => {
    const [hook, tracker] = scripts();
    expect(hook?.dangerouslySetInnerHTML).toEqual({ __html: CAMPAIGN_HOOK_SCRIPT });
    expect(tracker?.defer).toBe(true);
  });
});

describe('campaign hook', () => {
  it('puts back only the campaign tags, on the landing pageview only', () => {
    const hook = hookFor(
      '?lat=42.69751&lng=23.32415&utm_source=instagram&utm_medium=social&utm_campaign=launch&fbclid=abc',
    );
    expect(hook('event', { url: 'https://pops.bg/', website: 'w' }).url).toBe(
      'https://pops.bg/?utm_source=instagram&utm_medium=social&utm_campaign=launch',
    );
    expect(hook('event', { url: 'https://pops.bg/obekt/x', website: 'w' }).url).toBe(
      'https://pops.bg/obekt/x',
    );
  });

  it('leaves named events alone and still tags the first pageview', () => {
    const hook = hookFor('?utm_source=facebook');
    expect(hook('event', { url: 'https://pops.bg/', name: 'directions' }).url).toBe(
      'https://pops.bg/',
    );
    expect(hook('event', { url: 'https://pops.bg/' }).url).toBe(
      'https://pops.bg/?utm_source=facebook',
    );
  });

  it('adds nothing when the visit did not start from a campaign link', () => {
    const hook = hookFor('?lat=42.69751&lng=23.32415');
    expect(hook('event', { url: 'https://pops.bg/' }).url).toBe('https://pops.bg/');
  });

  it('also tags a pageview whose url is a bare path', () => {
    const hook = hookFor('?utm_campaign=launch&lat=42.69751');
    expect(hook('event', { url: '/' }).url).toBe('https://pops.bg/?utm_campaign=launch');
  });

  it('caps a tag at 200 characters', () => {
    const hook = hookFor(`?utm_content=${'a'.repeat(500)}`);
    const url = new URL(String(hook('event', { url: 'https://pops.bg/' }).url));
    expect(url.searchParams.get('utm_content')).toHaveLength(200);
  });
});
