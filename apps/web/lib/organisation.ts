/**
 * Who runs POPS, and how to reach them — the controller identity GDPR Art. 13
 * requires, and the single point of contact DSA Arts. 11-12 require.
 *
 * FROM THE ENVIRONMENT, NEVER A CONSTANT. The association's registered name,
 * ЕИК and seat address are operator data: they change without a deploy, they
 * were not known when this was written, and a guessed value on a legal page is
 * worse than none. So every field is optional and read at request time
 * (ORG_LEGAL_NAME, ORG_EIK, ORG_ADDRESS, CONTACT_EMAIL — plumbed through
 * deploy/compose.prod.yml and the deploy.yml heredoc as repository variables).
 *
 * FAIL CLOSED, FIELD BY FIELD, the donations recipe (lib/donations.ts): an unset
 * value is simply absent, and a malformed one is dropped with a value-free
 * warning, so a page renders the lines it can vouch for and omits the rest.
 * Nothing here ever substitutes a placeholder.
 */

export interface Organisation {
  /** The name exactly as registered, e.g. «Сдружение „…“». */
  legalName: string | null;
  /** ЕИК / БУЛСТАТ: 9 digits for a legal entity, 13 for a branch. */
  eik: string | null;
  /** Seat and address of management, one line. */
  address: string | null;
  /** Monitored inbox for users, rights holders and authorities. */
  contactEmail: string | null;
}

type Env = Record<string, string | undefined>;

/** Deliberately loose: rejects blanks, placeholders and pasted phone numbers, not RFC edge cases. */
const EMAIL_SHAPE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const EIK_SHAPE = /^(\d{9}|\d{13})$/;
const MAX_NAME = 200;
const MAX_ADDRESS = 300;

function clean(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function warn(variable: string, reason: string): void {
  // Value-free on purpose: this line can reach a log aggregator.
  console.warn(`[organisation] ${variable} ignored (${reason})`);
}

function text(env: Env, variable: string, max: number): string | null {
  const value = clean(env[variable]);
  if (!value) return null;
  if (value.length > max) {
    warn(variable, 'too long');
    return null;
  }
  return value;
}

export function organisation(env: Env = process.env): Organisation {
  const email = clean(env.CONTACT_EMAIL);
  let contactEmail: string | null = null;
  if (email) {
    if (EMAIL_SHAPE.test(email) && email.length <= 254) contactEmail = email;
    else warn('CONTACT_EMAIL', 'not an email address');
  }

  // Spaces and a "BG" VAT prefix are how the number is often pasted; neither
  // is part of the ЕИК itself.
  const eikRaw = clean(env.ORG_EIK).replace(/\s+/g, '').replace(/^BG/i, '');
  let eik: string | null = null;
  if (eikRaw) {
    if (EIK_SHAPE.test(eikRaw)) eik = eikRaw;
    else warn('ORG_EIK', 'not a 9- or 13-digit EIK');
  }

  return {
    legalName: text(env, 'ORG_LEGAL_NAME', MAX_NAME),
    eik,
    address: text(env, 'ORG_ADDRESS', MAX_ADDRESS),
    contactEmail,
  };
}

/** True when the site can name who is responsible for it. */
export function hasIdentity(org: Organisation): boolean {
  return org.legalName !== null;
}
