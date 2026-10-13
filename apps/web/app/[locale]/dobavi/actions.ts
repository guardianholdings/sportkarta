'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';

import { redirect, getPathname } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { addFacilityRateLimiter } from '@/lib/contribution-rate-limit';
import { addedLanding } from '@/lib/contributions/added-banner';
import { enqueuePassportEvaluate } from '@/lib/passport-evaluate';
import { addFacility } from '@/lib/contributions/add-facility';
import { ContributionError } from '@/lib/contributions/errors';
import { discardContributionPhoto, storeContributionPhoto } from '@/lib/contributions/photo-upload';
import { unexpectedFailure } from '@/lib/contributions/unexpected-failure';
import { SCRIPTED_SUBMIT_FIELD } from '@/lib/scripted-submit';

/**
 * Add a facility (Stage 3.2). Authenticated only — `requireUser` redirects an
 * anonymous caller, so the server action cannot be driven without an account
 * even though the page is also gated by middleware and the layout.
 */

export interface AddFacilityState {
  /** i18n key suffix under AddFacility.error.*; null when nothing failed yet. */
  error: string | null;
  /** Slug of the facility a rejected duplicate collided with. */
  conflictSlug?: string;
  /** B5: the code an unexpected failure was logged under, shown to the member. */
  reference?: string;
  /**
   * Set only after a SAVE whose thank-you is on this same page (a paid place
   * while paid venues are hidden), on a submit the form's script sent: the
   * form loads it as a new page. See lib/scripted-submit.ts for why it is not
   * a `redirect()`.
   */
  landing?: string;
}

export async function addFacilityAction(
  _prev: AddFacilityState,
  formData: FormData,
): Promise<AddFacilityState> {
  const user = await requireUser();

  if (!addFacilityRateLimiter.check(user.id).allowed) {
    return { error: 'rate_limited' };
  }

  let storagePath: string | null = null;
  let landing: string;
  try {
    // Photo first: a facility without evidence is not accepted, so there is no
    // point touching the database before the upload has been validated.
    storagePath = await storeContributionPhoto(formData.get('photo'), 'facilities');

    const result = await addFacility(getDb(), {
      userId: user.id,
      photoStoragePath: storagePath,
      // The browser's fix, if it offered one. Passed straight through: the
      // coordinates are turned into metres inside the transaction and are never
      // written down (lib/contributions/proximity.ts).
      position: { lat: formData.get('positionLat'), lon: formData.get('positionLon') },
      input: {
        name: String(formData.get('name') ?? ''),
        quarter: String(formData.get('quarter') ?? ''),
        sportTypes: formData.getAll('sportTypes').map(String),
        access: String(formData.get('access') ?? ''),
        // An empty field is NO coordinate, not 0: Number('') is 0, and an
        // untouched pin posts nothing (components/map/pin-picker.tsx), which
        // must read as «Изберете точка на картата», not «извън България».
        lon: coordinate(formData.get('lon')),
        lat: coordinate(formData.get('lat')),
      },
    });
    // Adding a facility is the platform's largest single award, and until
    // 2026-07-26 it was the only contribution flow that acknowledged nothing:
    // the redirect carried a bare `?added=1` that no page read. Carry the real
    // figure instead of a literal 10 so the banner cannot drift from the ledger
    // — and so a re-add that awarded nothing (the idempotency key already
    // paid) truthfully shows no points rather than claiming ten. A facility
    // the public site does not show (a paid one, while paid venues are hidden)
    // has no page to land on: that add is thanked on /dobavi instead of with
    // a 404 (UX audit 2026-10-10).
    landing = addedLanding(result);
  } catch (error) {
    // Nothing was committed, so the uploaded file must not dangle: addFacility
    // is one transaction, and everything else in the try is the upload or pure
    // code (addedLanding). A failure AFTER the commit cannot land here.
    await discardContributionPhoto(storagePath);
    if (error instanceof ContributionError) {
      return error.conflictSlug
        ? { error: error.code, conflictSlug: error.conflictSlug }
        : { error: error.code };
    }
    // B5: redirect()/notFound() pass through; anything else is our failure.
    // Line 11 keeps the form instead of the error page, and its code matches
    // one server log line (lib/contributions/unexpected-failure.ts).
    return { error: 'unexpected', ...unexpectedFailure('add-facility', error) };
  }

  // After the write COMMITS, before the redirect: adding a facility is the
  // largest award and the most likely thing to complete a badge (A1). It never
  // throws (it logs its own failure), so a saved facility always lands on
  // success, never on an error that invites a resend.
  await enqueuePassportEvaluate(user.id);

  // Outside the try: redirect() signals by throwing, and catching it here would
  // both swallow the navigation and delete a photo that now has a facility.
  // In the member's language: an unprefixed next/navigation path is the
  // Bulgarian page, which greeted English members' reward in Bulgarian.
  const target = { href: landing, locale: await getLocale() };
  // The thank-you on THIS page (/dobavi?saved=hidden…) goes back as a URL to a
  // scripted submit, which loads it as a new page: a redirect() to the page the
  // form is on could leave the client router stuck (lib/scripted-submit.ts).
  // getPathname() is the URL redirect() itself would send. A native POST (no
  // marker) still gets the 303.
  if (formData.get(SCRIPTED_SUBMIT_FIELD) === '1' && landing.split('?')[0] === '/dobavi') {
    return { error: null, landing: getPathname(target) };
  }
  return redirect(target);
}

function coordinate(value: FormDataEntryValue | null): number {
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
}
