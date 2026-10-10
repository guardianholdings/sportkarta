import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The session page, its RSVP form and the organiser's QR screen (UX audit
 * 2026-10-10, S-7 and S-14), asserted at the source level. The RSVP and
 * check-in rules themselves are tested against the database in db/src.
 */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

const page = source('../app/[locale]/sesiya/[occurrenceId]/page.tsx');
const rsvp = source('../app/[locale]/sesiya/[occurrenceId]/rsvp-form.tsx');
const qr = source('../app/[locale]/sesiya/[occurrenceId]/qr/page.tsx');
const occurrence = source('../lib/sessions/occurrence.ts');

describe('leaving a session (S-7)', () => {
  it('asks first — a waitlisted member who re-joins goes to the back', () => {
    expect(rsvp).toMatch(
      /<ConfirmButton[\s\S]*?status === 'waitlisted'[\s\S]*?labels\.leaveConfirmWaitlisted/,
    );
    // Joining costs nothing to undo, so it stays one tap.
    expect(rsvp).toMatch(/<Button\s+type="submit"[\s\S]*?labels\.join/);
  });

  it('announces the RSVP status from a live region that is always there', () => {
    expect(rsvp).toMatch(/<p role="status" className=\{statusText \?/);
    expect(page).toMatch(/statusText=\{/);
  });

  it('uses the shared form contract', () => {
    expect(rsvp).toMatch(/useFormAction\(rsvpAction/);
    expect(rsvp).toMatch(/useFormAction\(withdrawAction/);
    expect(rsvp).not.toMatch(/import \{[^}]*useActionState/);
  });
});

describe('a session that is over (S-14)', () => {
  it('is read as ended from ends_at, on the database clock', () => {
    expect(occurrence).toMatch(/\(o\.ends_at <= now\(\)\) AS ended/);
  });

  it('says it has ended, and stops inviting people and offering a calendar file', () => {
    expect(page).toMatch(/view\.ended \? t\('endedNotice'\) : t\('startedNotice'\)/);
    expect(page).toMatch(/\{!view\.cancelled && !view\.ended && \([\s\S]{0,400}<ShareSheet/);
    expect(page).toMatch(/\{!view\.ended && \(\s*<section aria-labelledby="cal-h"/);
  });
});

describe('the organiser QR screen (S-14)', () => {
  it('asks the window of the same SQL checkIn evaluates', () => {
    expect(qr).toMatch(/\$\{checkinWindowSql\(\)\} AS checkin_open/);
  });

  it('mints no code outside the window, and says when it opens or closed', () => {
    const outside = qr.indexOf("if (view.window !== 'open')");
    expect(outside).toBeGreaterThan(0);
    expect(outside).toBeLessThan(qr.indexOf('issueCheckinToken({'));
    expect(qr).toContain("t('windowOpensAt'");
    expect(qr).toContain("t('windowClosedAt'");
    expect(qr).toContain("t('windowOpenUntil'");
  });
});
