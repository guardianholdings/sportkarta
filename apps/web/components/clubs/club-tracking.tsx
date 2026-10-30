'use client';

import {
  decodeTrackingConsent,
  encodeTrackingConsent,
  trackingConsentKey,
  type TrackingConsent,
} from '@sportkarta/lib/clubs';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  clubTrackingRunning,
  landedHere,
  reloadToStart,
  startClubTracking,
  withdrawClubTracking,
  type ClubTrackingStart,
  type TrackingHost,
} from '@/lib/club-tracking-runtime';

/**
 * A paid club's own GA4 / Meta Pixel on its PUBLIC pages (wave H2, operator
 * decision 3) — and the consent that comes first.
 *
 *  - NOTHING LOADS before the visitor accepts: no script, no request, no
 *    cookie. The question sits at the top of the page (not a floating layer:
 *    it never covers the page or the bottom bar), with the two answers given
 *    the same weight.
 *  - The answer is kept in this browser only, per club (localStorage), never
 *    in a server cookie — the rest of pops.bg is untouched and still asks
 *    nothing. It lasts a year, then the question comes back.
 *  - It can always be changed. Withdrawing switches the vendors off, clears
 *    their cookies on every path of the club's pages and reloads.
 *  - What runs once accepted — and why it never follows the visitor off the
 *    club's page — is lib/club-tracking-runtime.ts.
 */

function readConsent(key: string): TrackingConsent | null {
  try {
    return decodeTrackingConsent(window.localStorage.getItem(key), new Date());
  } catch {
    return null;
  }
}

function writeConsent(key: string, value: TrackingConsent): void {
  try {
    window.localStorage.setItem(key, encodeTrackingConsent(value, new Date()));
  } catch {
    // Private mode or blocked storage: the answer lasts for this page only.
  }
}

function host(): TrackingHost {
  return window as unknown as TrackingHost;
}

/** Start in a document of its own: a page reached in-app is reloaded first. */
function begin(start: ClubTrackingStart): void {
  if (clubTrackingRunning(host())) return;
  if (!landedHere(host())) {
    reloadToStart(host());
    return;
  }
  startClubTracking(host(), start);
}

export interface ClubTrackingStrings {
  title: string;
  body: string;
  accept: string;
  decline: string;
  policy: string;
  granted: string;
  denied: string;
  change: string;
}

export function ClubTracking({
  clubId,
  gaId,
  metaId,
  cookiePath,
  cookiePaths,
  policyUrl,
  leadId = null,
  hideParams = [],
  strings,
}: {
  clubId: string;
  gaId: string | null;
  metaId: string | null;
  /** This page's club path: /klub/<slug>, with the locale prefix. */
  cookiePath: string;
  /** The club's path in every locale, for clearing cookies on withdrawal. */
  cookiePaths: readonly string[];
  policyUrl: string | null;
  /** The inquiry this page confirms: Lead is reported once for it. */
  leadId?: string | null;
  /** Query parameters the vendors must not see (taken out of the address bar). */
  hideParams?: readonly string[];
  strings: ClubTrackingStrings;
}) {
  const key = trackingConsentKey(clubId);
  // null until the browser's answer is read: the server renders no question.
  const [consent, setConsent] = useState<TrackingConsent | 'ask' | null>(null);
  const focusNext = useRef<'ask' | 'answer' | null>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const hidden = hideParams.join(',');

  useEffect(() => {
    const stored = readConsent(key);
    setConsent(stored ?? 'ask');
    if (stored === 'granted') {
      begin({ gaId, metaId, cookiePath, leadId, hideParams: hidden ? hidden.split(',') : [] });
    }
  }, [key, gaId, metaId, cookiePath, leadId, hidden]);

  // Keep keyboard focus with the question or the answer as they swap.
  useEffect(() => {
    if (focusNext.current === 'ask' && consent === 'ask') titleRef.current?.focus();
    if (focusNext.current === 'answer' && consent !== 'ask') resultRef.current?.focus();
    focusNext.current = null;
  }, [consent]);

  if (consent === null) return null;

  if (consent !== 'ask') {
    return (
      <p ref={resultRef} tabIndex={-1} role="status" className="text-caption text-ink-soft">
        {consent === 'granted' ? strings.granted : strings.denied}{' '}
        <button
          type="button"
          className="min-h-11 font-semibold text-link hover:text-link-hover"
          onClick={() => {
            focusNext.current = 'ask';
            setConsent('ask');
          }}
        >
          {strings.change}
        </button>
      </p>
    );
  }

  const answer = (value: TrackingConsent) => {
    writeConsent(key, value);
    focusNext.current = 'answer';
    setConsent(value);
    if (value === 'granted') {
      begin({ gaId, metaId, cookiePath, leadId, hideParams });
      return;
    }
    // Reloads when the vendors were running here; otherwise just clears.
    withdrawClubTracking(host(), gaId, cookiePaths);
  };

  return (
    <section
      aria-labelledby="club-tracking-h"
      className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm"
    >
      {/* Not a heading: the banner comes before the page's own h1. */}
      <p id="club-tracking-h" ref={titleRef} tabIndex={-1} className="text-body font-bold text-ink">
        {strings.title}
      </p>
      <p className="max-w-prose text-body-sm text-ink-soft">{strings.body}</p>
      {policyUrl && (
        <p className="text-body-sm">
          <a
            href={policyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-link hover:text-link-hover"
          >
            {strings.policy}
          </a>
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={() => answer('granted')}>
          {strings.accept}
        </Button>
        <Button type="button" variant="secondary" onClick={() => answer('denied')}>
          {strings.decline}
        </Button>
      </div>
    </section>
  );
}
