import { notFound, redirect } from 'next/navigation';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { describe, expect, it } from 'vitest';

import { classifyActionFailure } from '../lib/form-action-failure';

/**
 * B2 (add-facility errors): when the browser calls a server action and gets no
 * usable answer, Next throws in the client and the page fell through to the
 * error screen, even when the facility HAD been saved. The forms now catch that
 * throw and say what happened. Two cases must be told apart:
 * - a stale form after a deploy (404 + `x-nextjs-action-not-found`): nothing ran;
 * - a lost answer (cut connection, a 502 page): the action may have run.
 * Next's own control-flow throws must still pass through, or a successful add
 * would stop navigating to its thanks page.
 */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('classifyActionFailure', () => {
  it('reads a 404 with x-nextjs-action-not-found as a stale form', () => {
    const error = new UnrecognizedActionError(
      'Server Action "4062b0" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    );
    expect(classifyActionFailure(error)).toBe('stale_form');
  });

  it('reads a cut connection as a lost answer', () => {
    expect(classifyActionFailure(new TypeError('Failed to fetch'))).toBe('no_answer');
  });

  it('reads a page that is not an action answer (a 502 from the proxy) as a lost answer', () => {
    expect(
      classifyActionFailure(new Error('An unexpected response was received from the server.')),
    ).toBe('no_answer');
  });

  it('rethrows a redirect, so a saved facility still lands on its thanks page', () => {
    const error = thrownBy(() => redirect('/bg/dobavi?added=1'));
    expect(() => classifyActionFailure(error)).toThrow('NEXT_REDIRECT');
  });

  it('rethrows notFound', () => {
    const error = thrownBy(() => notFound());
    expect(() => classifyActionFailure(error)).toThrow('NEXT_HTTP_ERROR_FALLBACK');
  });
});
