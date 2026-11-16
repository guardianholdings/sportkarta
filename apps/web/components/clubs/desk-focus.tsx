'use client';

import { useEffect } from 'react';

/**
 * Puts the cursor back where the desk works after every arrival.
 *
 * A desk action answers with a redirect to the same page, which the router
 * applies in place: the fields stay mounted, so `autoFocus` never fires again
 * and the cursor is left on nothing. A USB card reader is a keyboard — its
 * next scan then goes nowhere — and the person at the desk has to reach for
 * the mouse between every two clients. The page also keeps its scroll
 * position, so on a tablet the answer («…няма валиден абонамент») can sit
 * above the screen.
 *
 * No dependency list on purpose: the component holds no state, so it renders
 * again exactly when the page does — once per answer, including the same
 * answer twice (the same card read again).
 *
 * Without JavaScript the page is loaded whole and the `autoFocus` attribute on
 * the same field does this job.
 */
export function DeskFocus({ fieldId, outcomeId }: { fieldId: string; outcomeId: string }) {
  useEffect(() => {
    const field = document.getElementById(fieldId);
    if (!(field instanceof HTMLInputElement)) return;
    const outcome = document.getElementById(outcomeId);
    if (outcome && outcome.childElementCount > 0) {
      outcome.scrollIntoView({ block: 'nearest' });
      field.focus({ preventScroll: true });
    } else {
      field.focus();
    }
  });
  return null;
}
