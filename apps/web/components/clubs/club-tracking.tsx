'use client';

import {
  decodeTrackingConsent,
  encodeTrackingConsent,
  trackingAnswered,
  trackingConsentKey,
  type TrackingChoices,
  type TrackingVendor,
} from '@sportkarta/lib/clubs';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  clubTrackingIds,
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
 *    it never covers the page or the bottom bar), with the answers given the
 *    same weight.
 *  - PER TOOL: measurement (GA4) and advertising (Meta) are different
 *    purposes, so with both in use the visitor may accept either, both or
 *    neither; only accepted tools load. A tool the club adds later is asked
 *    about afresh.
 *  - The answer is kept in this browser only, per club (localStorage), never
 *    in a server cookie — the rest of pops.bg is untouched and still asks
 *    nothing. It lasts a year (or until the wording changes).
 *  - It can always be changed. Taking a yes back switches the vendors off,
 *    clears their cookies on every path of the club's pages and reloads.
 *  - What runs once accepted — and why it never follows the visitor off the
 *    club's page — is lib/club-tracking-runtime.ts.
 */

function readConsent(key: string): TrackingChoices | null {
  try {
    return decodeTrackingConsent(window.localStorage.getItem(key), new Date());
  } catch {
    return null;
  }
}

function writeConsent(key: string, choices: TrackingChoices): void {
  try {
    window.localStorage.setItem(key, encodeTrackingConsent(choices, new Date()));
  } catch {
    // Private mode or blocked storage: the answer lasts for this page only.
  }
}

function host(): TrackingHost {
  return window as unknown as TrackingHost;
}

/** Start in a document of its own: a page reached in-app is reloaded first. */
function begin(start: ClubTrackingStart): void {
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
  acceptAll: string;
  declineAll: string;
  save: string;
  choiceGa: string;
  choiceMeta: string;
  policy: string;
  granted: string;
  grantedOnlyGa: string;
  grantedOnlyMeta: string;
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
  const vendors: TrackingVendor[] = [];
  if (gaId) vendors.push('ga');
  if (metaId) vendors.push('meta');
  const both = vendors.length === 2;
  // null until the browser's answer is read: the server renders no question.
  const [choices, setChoices] = useState<TrackingChoices | 'ask' | null>(null);
  const [picked, setPicked] = useState<TrackingChoices>({});
  const focusNext = useRef<'ask' | 'answer' | null>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const hidden = hideParams.join(',');
  const asked = vendors.join(',');

  /** Run exactly the accepted tools — starting, adding or taking one back. */
  const apply = (next: TrackingChoices, answered: boolean) => {
    const want = { gaId: next.ga ? gaId : null, metaId: next.meta ? metaId : null };
    const now = clubTrackingIds(host());
    if (now) {
      if (now.gaId === want.gaId && now.metaId === want.metaId) return;
      if ((now.gaId && !want.gaId) || (now.metaId && !want.metaId)) {
        // A yes taken back: off, cookies cleared, a fresh document.
        withdrawClubTracking(host(), gaId, cookiePaths);
      } else {
        // A tool added: both start together in a fresh document.
        host().location.reload();
      }
      return;
    }
    if (want.gaId || want.metaId) {
      begin({ ...want, cookiePath, leadId, hideParams: hidden ? hidden.split(',') : [] });
    } else if (answered) {
      // Nothing running here; a fresh no still clears leftovers.
      withdrawClubTracking(host(), gaId, cookiePaths);
    }
  };

  useEffect(() => {
    const stored = readConsent(key);
    const tools = asked.split(',') as TrackingVendor[];
    if (!trackingAnswered(stored, tools)) {
      setChoices('ask');
      return;
    }
    setChoices(stored);
    apply(stored, false);
    // `apply` reads only the props listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, asked, gaId, metaId, cookiePath, leadId, hidden]);

  // Keep keyboard focus with the question or the answer as they swap.
  useEffect(() => {
    if (focusNext.current === 'ask' && choices === 'ask') titleRef.current?.focus();
    if (focusNext.current === 'answer' && choices !== 'ask') resultRef.current?.focus();
    focusNext.current = null;
  }, [choices]);

  if (choices === null) return null;

  const answer = (next: TrackingChoices) => {
    writeConsent(key, next);
    focusNext.current = 'answer';
    setChoices(next);
    apply(next, true);
  };
  const all = (value: boolean): TrackingChoices =>
    Object.fromEntries(vendors.map((vendor) => [vendor, value]));

  if (choices !== 'ask') {
    const yes = vendors.filter((vendor) => choices[vendor]);
    const summary =
      yes.length === vendors.length
        ? strings.granted
        : yes.length === 0
          ? strings.denied
          : yes[0] === 'ga'
            ? strings.grantedOnlyGa
            : strings.grantedOnlyMeta;
    return (
      <p ref={resultRef} tabIndex={-1} role="status" className="text-caption text-ink-soft">
        {summary}{' '}
        <button
          type="button"
          className="min-h-11 font-semibold text-link hover:text-link-hover"
          onClick={() => {
            focusNext.current = 'ask';
            setPicked(choices);
            setChoices('ask');
          }}
        >
          {strings.change}
        </button>
      </p>
    );
  }

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
      {both && (
        <fieldset className="space-y-1">
          {(['ga', 'meta'] as const).map((vendor) => (
            <label key={vendor} className="flex min-h-11 items-center gap-2 text-body-sm text-ink">
              <input
                type="checkbox"
                className="size-5 shrink-0"
                checked={picked[vendor] === true}
                onChange={(event) =>
                  setPicked((current) => ({ ...current, [vendor]: event.target.checked }))
                }
              />
              {vendor === 'ga' ? strings.choiceGa : strings.choiceMeta}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={() => answer(all(true))}>
          {both ? strings.acceptAll : strings.accept}
        </Button>
        <Button type="button" variant="secondary" onClick={() => answer(all(false))}>
          {both ? strings.declineAll : strings.decline}
        </Button>
        {both && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => answer({ ga: picked.ga === true, meta: picked.meta === true })}
          >
            {strings.save}
          </Button>
        )}
      </div>
    </section>
  );
}
