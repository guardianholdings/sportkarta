import { META_PIXEL_SCRIPT_URL, gaScriptUrl, isTrackingCookie } from '@sportkarta/lib/clubs';

/**
 * What runs in the visitor's browser once they have accepted a club's own
 * GA4 / Meta Pixel (wave H2). Client-only, and written against a small host
 * interface instead of `window` so the rules below are tested in plain Node
 * (tests/club-tracking-runtime.test.ts).
 *
 * ONE DOCUMENT, ONE ADDRESS. The vendors' scripts cannot be unloaded, and
 * both follow in-app navigation on their own (GA4's history-based page views,
 * Meta's pushState hook). So a document in which they run never shows another
 * address:
 *
 *  - they start only in a document that was LOADED at this address (a club
 *    page reached by in-app navigation is reloaded first) — so they always
 *    run under the club pages' script policy (lib/club-page-csp.ts);
 *  - from then on every move to another address is a full page load: a link
 *    click is left to the browser's own navigation, back/forward reloads, and
 *    any programmatic route change (a form's redirect) switches the vendors
 *    off on the spot and then reloads.
 *
 * Nothing they run therefore sees the map, the portal, the purchase flow or
 * another club's page, and events cannot cross from one club's pixel to
 * another's (each call also names its own id: `trackSingle`, `send_to`).
 *
 * Also: Meta's automatic configuration is off (no button texts, no page
 * metadata, no form scanning), a same-site referrer is cut to its path (the
 * map keeps its viewport in the query), and withdrawing switches both vendors
 * off BEFORE their cookies are cleared, so the reload's own beacon cannot
 * write them back.
 */

export interface FbQueue {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[];
  push: FbQueue;
  loaded: boolean;
  version: string;
  disablePushState?: boolean;
}

interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: unknown;
  stopPropagation(): void;
}

interface AnchorLike {
  href: string;
  target: string;
  hasAttribute(name: string): boolean;
}

type HistoryWrite = (data: unknown, unused: string, url?: string | URL | null) => void;

/** The part of `window` this module touches. */
export interface TrackingHost {
  location: {
    href: string;
    origin: string;
    pathname: string;
    search: string;
    hostname: string;
    reload(): void;
  };
  history: { state: unknown; pushState: HistoryWrite; replaceState: HistoryWrite };
  document: {
    referrer: string;
    cookie: string;
    head: { appendChild(node: never): unknown };
    createElement(tag: 'script'): { async: boolean; src: string };
    querySelector(selector: string): unknown;
  };
  performance?: { getEntriesByType(type: string): { name: string }[] };
  sessionStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  addEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  fbq?: FbQueue;
  _fbq?: FbQueue;
}

export interface ClubTrackingStart {
  gaId: string | null;
  metaId: string | null;
  /** This page's club path (/klub/<slug>, locale prefix included): GA4's cookie_path. */
  cookiePath: string;
  /** The inquiry this page confirms, if any: Lead is sent once per inquiry. */
  leadId: string | null;
  /** Query parameters to take out of the address bar before anything loads. */
  hideParams: readonly string[];
}

interface Running {
  gaId: string | null;
  metaId: string | null;
}

const running = new WeakMap<object, Running>();

export function clubTrackingRunning(host: TrackingHost): boolean {
  return running.has(host);
}

/** Was this document loaded at the address it shows (ignoring the query)? */
export function landedHere(host: TrackingHost): boolean {
  const entry = host.performance?.getEntriesByType('navigation')[0];
  if (!entry) return true;
  try {
    return new URL(entry.name).pathname === host.location.pathname;
  } catch {
    return true;
  }
}

function reloadMarker(host: TrackingHost): string {
  return `pops-club-tracking-reload:${host.location.pathname}`;
}

/**
 * Reload so the vendors start in a document of their own — once per address:
 * if the reload did not help, stay off rather than loop.
 */
export function reloadToStart(host: TrackingHost): boolean {
  const marker = reloadMarker(host);
  try {
    if (host.sessionStorage?.getItem(marker)) return false;
    host.sessionStorage?.setItem(marker, '1');
  } catch {
    return false;
  }
  host.location.reload();
  return true;
}

/** Start the club's vendors in this document (idempotent). */
export function startClubTracking(host: TrackingHost, start: ClubTrackingStart): void {
  if (running.has(host)) return;
  const state: Running = { gaId: start.gaId, metaId: start.metaId };
  running.set(host, state);
  try {
    host.sessionStorage?.removeItem(reloadMarker(host));
  } catch {
    // Nothing to clear.
  }
  hideQueryParams(host, start.hideParams);
  trimSameSiteReferrer(host);
  installLeaveGuard(host, state);
  const lead = leadDue(host, start.leadId);
  if (start.gaId) startGa(host, start.gaId, start.cookiePath, lead);
  if (start.metaId) startMeta(host, start.metaId, lead);
}

/**
 * Withdraw: vendors off first, then every cookie they may have set on any of
 * the club's paths, then — if they were running here — a fresh document.
 */
export function withdrawClubTracking(
  host: TrackingHost,
  gaId: string | null,
  cookiePaths: readonly string[],
): void {
  const state = running.get(host);
  if (state) stopVendors(host, state);
  clearTrackingCookies(host, gaId, cookiePaths);
  if (state) host.location.reload();
}

function stopVendors(host: TrackingHost, state: Running): void {
  if (state.gaId) (host as unknown as Record<string, unknown>)[`ga-disable-${state.gaId}`] = true;
  if (state.metaId) host.fbq?.('consent', 'revoke');
}

function addressOf(host: TrackingHost, url: string | URL): URL | null {
  try {
    return new URL(String(url), host.location.href);
  } catch {
    return null;
  }
}

function hideQueryParams(host: TrackingHost, names: readonly string[]): void {
  const url = addressOf(host, host.location.href);
  if (!url || !names.some((name) => url.searchParams.has(name))) return;
  for (const name of names) url.searchParams.delete(name);
  host.history.replaceState(host.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function trimSameSiteReferrer(host: TrackingHost): void {
  const from = host.document.referrer ? addressOf(host, host.document.referrer) : null;
  if (!from || from.origin !== host.location.origin) return;
  const trimmed = `${from.origin}${from.pathname}`;
  if (trimmed === host.document.referrer) return;
  // The vendors read document.referrer; this document's own copy is cut.
  Object.defineProperty(host.document, 'referrer', { configurable: true, get: () => trimmed });
}

function closestAnchor(target: unknown): AnchorLike | null {
  const element = target as { closest?: (selector: string) => unknown } | null;
  const found = element?.closest?.('a[href]');
  return found ? (found as AnchorLike) : null;
}

function installLeaveGuard(host: TrackingHost, state: Running): void {
  const here = `${host.location.pathname}${host.location.search}`;
  const leaves = (url: string | URL | null | undefined): boolean => {
    if (url === null || url === undefined) return false;
    const next = addressOf(host, url);
    if (!next) return false;
    return next.origin !== host.location.origin || `${next.pathname}${next.search}` !== here;
  };

  const onClick = (event: ClickLike) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const anchor = closestAnchor(event.target);
    if (!anchor || (anchor.target && anchor.target !== '_self')) return;
    if (anchor.hasAttribute('download') || !leaves(anchor.href)) return;
    // In-app routing never sees the click; the browser follows the link.
    event.stopPropagation();
  };
  host.addEventListener('click', onClick as (event: never) => void, true);

  const onPopState = (event: { stopImmediatePropagation(): void }) => {
    if (!leaves(host.location.href)) return;
    event.stopImmediatePropagation();
    host.location.reload();
  };
  host.addEventListener('popstate', onPopState as (event: never) => void, true);

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = host.history[method];
    host.history[method] = function guarded(data, unused, url) {
      const leaving = leaves(url);
      if (leaving) stopVendors(host, state);
      original.call(host.history, data, unused, url);
      if (leaving) host.location.reload();
    };
  }
}

function leadDue(host: TrackingHost, leadId: string | null): boolean {
  if (!leadId) return false;
  const key = `pops-club-lead:${leadId}`;
  try {
    if (host.sessionStorage?.getItem(key)) return false;
    host.sessionStorage?.setItem(key, '1');
  } catch {
    // Storage blocked: report it this once anyway.
  }
  return true;
}

function appendScript(host: TrackingHost, src: string): void {
  if (host.document.querySelector(`script[src="${src}"]`)) return;
  const script = host.document.createElement('script');
  script.async = true;
  script.src = src;
  host.document.head.appendChild(script as never);
}

function startGa(host: TrackingHost, id: string, cookiePath: string, lead: boolean): void {
  const layer = (host.dataLayer = host.dataLayer ?? []);
  // gtag.js reads an Arguments object off the data layer, not an array.
  host.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    layer.push(arguments);
  };
  host.gtag('js', new Date());
  host.gtag('config', id, {
    cookie_path: cookiePath,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  if (lead) host.gtag('event', 'generate_lead', { send_to: id });
  appendScript(host, gaScriptUrl(id));
}

function startMeta(host: TrackingHost, id: string, lead: boolean): void {
  if (!host.fbq) {
    // Meta's own queueing stub, so calls made before fbevents.js arrives wait.
    const fbq = ((...args: unknown[]) => {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    }) as FbQueue;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    host.fbq = fbq;
    host._fbq = fbq;
  }
  // No page view of its own on history changes (the guard reloads instead).
  host.fbq.disablePushState = true;
  // No automatic events: no button texts, page metadata or form scanning.
  host.fbq('set', 'autoConfig', false, id);
  host.fbq('init', id);
  host.fbq('trackSingle', id, 'PageView');
  if (lead) host.fbq('trackSingle', id, 'Lead');
  appendScript(host, META_PIXEL_SCRIPT_URL);
}

/** Cookies a path cannot see are expired blind, by the names the vendors use. */
const KNOWN_TRACKING_COOKIES = [
  '_ga',
  '_fbp',
  '_fbc',
  '_gcl_au',
  '_gcl_aw',
  '_gcl_dc',
  '_gcl_gb',
  '_gcl_gs',
  '_gcl_ag',
];

function clearTrackingCookies(
  host: TrackingHost,
  gaId: string | null,
  cookiePaths: readonly string[],
): void {
  const seen = host.document.cookie
    .split(';')
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter(isTrackingCookie);
  const names = new Set([...seen, ...KNOWN_TRACKING_COOKIES]);
  if (gaId) names.add(`_ga_${gaId.slice(2)}`);
  const labels = host.location.hostname.split('.');
  const domains: (string | null)[] = [null];
  for (let i = 0; i < labels.length - 1; i += 1) domains.push(`.${labels.slice(i).join('.')}`);
  for (const name of names) {
    for (const path of new Set(['/', ...cookiePaths])) {
      for (const domain of domains) {
        host.document.cookie = `${name}=; Max-Age=0; path=${path}${domain ? `; domain=${domain}` : ''}`;
      }
    }
  }
}
