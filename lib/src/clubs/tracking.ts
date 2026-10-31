/**
 * A paid club's own Google Analytics 4 and Meta Pixel on ITS public pages
 * (wave H2, 0058; operator decision 3, 2026-10-25). Client-safe and pure.
 *
 * IDs ONLY. A club enters an id; POPS builds the vendor's script address
 * here, so nothing a club types ever becomes code on pops.bg's origin — which
 * is also why Google Tag Manager is not offered (a container runs whatever
 * its owner publishes). The ids' shapes are CHECKs on clubs (0058) as well.
 *
 * Nothing a club types becomes POPS code — but an id is not inert either:
 * each vendor's script fetches that id's own configuration from the vendor
 * (Google's linked destinations, Meta's event setup), which the club controls
 * in the vendor's console. That is why the scripts run only in a document
 * that never leaves the club's page (apps/web/lib/club-tracking-runtime.ts),
 * and why Meta's automatic configuration is switched off.
 *
 * NOTHING LOADS BEFORE CONSENT. The banner on the club's public pages asks
 * once per club and PER TOOL (measurement and advertising are separate
 * purposes); the answer lives in the visitor's own browser storage under
 * `trackingConsentKey`, never in a server cookie, and is asked again after
 * TRACKING_CONSENT_DAYS or when the wording changes. Only accepted tools
 * load; either answer can be changed later.
 */

const GA_MEASUREMENT_ID = /^G-[A-Z0-9]{4,12}$/;
const META_PIXEL_ID = /^[0-9]{6,20}$/;

/** A GA4 measurement id as typed (case and spaces forgiven), null for empty, or 'invalid'. */
export function parseGaMeasurementId(raw: string): string | null | 'invalid' {
  const value = raw.trim().toUpperCase();
  if (value === '') return null;
  return GA_MEASUREMENT_ID.test(value) ? value : 'invalid';
}

/** A Meta Pixel id as typed (spaces forgiven), null for empty, or 'invalid'. */
export function parseMetaPixelId(raw: string): string | null | 'invalid' {
  const value = raw.replace(/\s+/g, '');
  if (value === '') return null;
  return META_PIXEL_ID.test(value) ? value : 'invalid';
}

export function isGaMeasurementId(value: unknown): value is string {
  return typeof value === 'string' && GA_MEASUREMENT_ID.test(value);
}

export function isMetaPixelId(value: unknown): value is string {
  return typeof value === 'string' && META_PIXEL_ID.test(value);
}

/** The only origins a club page may load a tracking script from. */
export const TRACKING_SCRIPT_ORIGINS = [
  'https://www.googletagmanager.com',
  'https://connect.facebook.net',
] as const;

export function gaScriptUrl(measurementId: string): string {
  return `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
}

export const META_PIXEL_SCRIPT_URL = 'https://connect.facebook.net/en_US/fbevents.js';

/** Where a visitor's answer for one club is kept — their browser, per club. */
export function trackingConsentKey(clubId: string): string {
  return `pops-club-tracking:${clubId}`;
}

/** The two tools a club may add — and the two purposes a visitor answers for. */
export type TrackingVendor = 'ga' | 'meta';

export const TRACKING_VENDORS: readonly TrackingVendor[] = ['ga', 'meta'];

/**
 * A visitor's answer, PER TOOL: measurement (GA4) and advertising (Meta) are
 * different purposes, and consent to one is not consent to the other. A tool
 * the visitor was never asked about (the club added it later) is missing, so
 * the banner asks again rather than read an old yes as covering it.
 */
export type TrackingChoices = Partial<Record<TrackingVendor, boolean>>;

/**
 * The banner's wording version. Raise it when what the banner says changes
 * (purposes, recipients, transfers): every stored answer then lapses and the
 * visitor is asked again under the new text.
 */
export const TRACKING_CONSENT_VERSION = 1;

/** An answer lasts a year; then the banner asks again. */
export const TRACKING_CONSENT_DAYS = 365;

/** The stored form of an answer: the choices, the wording version, the civil date. */
export function encodeTrackingConsent(choices: TrackingChoices, now: Date): string {
  const stored: Record<string, unknown> = {
    v: TRACKING_CONSENT_VERSION,
    at: now.toISOString().slice(0, 10),
  };
  for (const vendor of TRACKING_VENDORS) {
    const choice = choices[vendor];
    if (typeof choice === 'boolean') stored[vendor] = choice;
  }
  return JSON.stringify(stored);
}

/** A stored answer that is still current, or null: ask again. */
export function decodeTrackingConsent(raw: string | null, now: Date): TrackingChoices | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const stored = parsed as Record<string, unknown>;
  const at = stored.at;
  if (stored.v !== TRACKING_CONSENT_VERSION) return null;
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(at)) return null;
  const given = Date.parse(`${at}T00:00:00Z`);
  if (Number.isNaN(given) || given > now.getTime()) return null;
  if (now.getTime() - given >= TRACKING_CONSENT_DAYS * 86_400_000) return null;
  const choices: TrackingChoices = {};
  for (const vendor of TRACKING_VENDORS) {
    const choice = stored[vendor];
    if (typeof choice === 'boolean') choices[vendor] = choice;
  }
  return choices;
}

/** Has the visitor answered for every tool this club uses? */
export function trackingAnswered(
  choices: TrackingChoices | null,
  vendors: readonly TrackingVendor[],
): choices is TrackingChoices {
  return choices !== null && vendors.every((vendor) => typeof choices[vendor] === 'boolean');
}

/**
 * The first-party cookies the two vendors set, cleared when a visitor
 * withdraws: GA4's `_ga` and `_ga_<id>`, the Google tag's ad-linker cookies
 * (`_gcl_*`, `_gac_*` — set when the club links its G- tag to Google Ads in
 * Google's console), and Meta's `_fbp` and `_fbc`.
 */
export function isTrackingCookie(name: string): boolean {
  return (
    name === '_ga' ||
    name.startsWith('_ga_') ||
    name.startsWith('_gcl_') ||
    name.startsWith('_gac_') ||
    name === '_fbp' ||
    name === '_fbc'
  );
}
