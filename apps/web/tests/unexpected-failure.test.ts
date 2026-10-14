import { notFound, redirect } from 'next/navigation';
import { describe, expect, it } from 'vitest';

import { newReference, unexpectedFailure } from '../lib/contributions/unexpected-failure';

/**
 * B5: the add action's safety net. A failure that is neither a refusal the form
 * can explain (ContributionError) nor Next's own control flow becomes line 11
 * plus a reference code, and the server log gets the same code, so a member's
 * message can be matched to exactly one log line. Nothing the member typed may
 * reach that line: a database error can quote the values it was given.
 */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const REFERENCE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

describe('unexpectedFailure', () => {
  it('gives the member a code and logs the same code, the error name and its code', () => {
    const error = Object.assign(new Error('insert failed'), {
      name: 'PostgresError',
      code: '23505',
    });
    const lines: string[] = [];
    const { reference } = unexpectedFailure('add-facility', error, (line) => lines.push(line));
    expect(reference).toMatch(REFERENCE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[add-facility]');
    expect(lines[0]).toContain(`ref=${reference}`);
    expect(lines[0]).toContain('PostgresError');
    expect(lines[0]).toContain('code=23505');
  });

  it('never logs the message, which can quote what the member typed', () => {
    const error = Object.assign(
      new Error('Key (name)=(Игрище на Иван) at 42.6977,23.3219\nDETAIL: Иван 0888123456'),
      { code: '23505' },
    );
    const lines: string[] = [];
    unexpectedFailure('add-facility', error, (line) => lines.push(line));
    const logged = lines.join('\n');
    expect(logged).not.toContain('Иван');
    expect(logged).not.toContain('42.6977');
    expect(logged).not.toContain('0888123456');
    // Where it failed is kept: stack frames carry code locations, not input.
    expect(logged).toMatch(/\n\s+at /);
  });

  it('logs no code that could be free text', () => {
    const error = Object.assign(new Error('x'), { code: 'value was Иван, 42.69' });
    const lines: string[] = [];
    unexpectedFailure('add-facility', error, (line) => lines.push(line));
    expect(lines[0]).not.toContain('code=');
    expect(lines[0]).not.toContain('Иван');
  });

  it('copes with a thrown non-Error without logging its content', () => {
    const lines: string[] = [];
    const { reference } = unexpectedFailure('add-facility', 'Иван 42.6977', (line) =>
      lines.push(line),
    );
    expect(reference).toMatch(REFERENCE);
    expect(lines.join('\n')).not.toContain('Иван');
  });

  it('lets redirect() and notFound() through, so a saved facility still lands on its page', () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const redirected = thrownBy(() => redirect('/bg/obekt/igrishte'));
    expect(() => unexpectedFailure('add-facility', redirected, log)).toThrow('NEXT_REDIRECT');
    const missing = thrownBy(() => notFound());
    expect(() => unexpectedFailure('add-facility', missing, log)).toThrow(
      'NEXT_HTTP_ERROR_FALLBACK',
    );
    expect(lines).toHaveLength(0);
  });
});

describe('newReference', () => {
  it('is 8 characters a member can read out (no I, L, O or U), and differs each time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const reference = newReference();
      expect(reference).toMatch(REFERENCE);
      seen.add(reference);
    }
    expect(seen.size).toBeGreaterThan(45);
  });
});
