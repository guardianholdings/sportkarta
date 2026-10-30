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
 * once per club (the answer lives in the visitor's own browser storage under
 * `trackingConsentKey`, never in a server cookie, and is asked again after
 * TRACKING_CONSENT_DAYS); accepting loads the scripts, declining loads
 * nothing, and either can be changed later.
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

export type TrackingConsent = 'granted' | 'denied';

export function isTrackingConsent(value: unknown): value is TrackingConsent {
  return value === 'granted' || value === 'denied';
}

/** An answer lasts a year; then the banner asks again. */
export const TRACKING_CONSENT_DAYS = 365;

/** The stored form of an answer: the answer and the civil date it was given. */
export function encodeTrackingConsent(answer: TrackingConsent, now: Date): string {
  return JSON.stringify({ answer, at: now.toISOString().slice(0, 10) });
}

/** A stored answer that is still current, or null: ask again. */
export function decodeTrackingConsent(raw: string | null, now: Date): TrackingConsent | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { answer, at } = parsed as { answer?: unknown; at?: unknown };
  if (!isTrackingConsent(answer) || typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    return null;
  }
  const given = Date.parse(`${at}T00:00:00Z`);
  if (Number.isNaN(given) || given > now.getTime()) return null;
  return now.getTime() - given < TRACKING_CONSENT_DAYS * 86_400_000 ? answer : null;
}

/** What a page may report beyond the page view (Purchase is not sent: see ROADMAP H2). */
export type TrackingEvent = 'lead';

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
