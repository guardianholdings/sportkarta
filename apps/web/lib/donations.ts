/**
 * Donation details for `/podkrepi` (docs/MONETISATION.md S4, phase M1).
 *
 * BANK TRANSFER ONLY, and that is an architecture decision rather than a
 * missing feature. A card-payment widget means a payment provider's script,
 * which would be the FIRST third-party script on the site — it would need a
 * consent banner (the platform is cookieless and the privacy page promises no
 * tracking) and it would break that promise for the sake of a donation form.
 * So this module never handles money: it renders an IBAN, and the optional
 * `DONATION_PAYMENT_URL` is a link OUT to a processor-HOSTED page, where the
 * processor's cookies live on the processor's domain.
 *
 * Everything comes from the environment, never from a constant in the repo:
 * bank details are operator data that changes without a deploy, and hardcoding
 * an IBAN would put a real account number in git history.
 *
 * FAIL CLOSED, LOUDLY. A malformed IBAN yields `null` — the page then shows the
 * "write to us for bank details" fallback rather than an account number nobody
 * can pay into. The warning names the variable and NEVER its value.
 */

export interface DonationDetails {
  /** Normalised: uppercase, no spaces — the form a banking app accepts. */
  iban: string;
  /** Account holder exactly as the bank knows it, or a transfer bounces. */
  beneficiary: string;
  bic: string | null;
  /** Suggested transfer reference ("дарение"), so the operator can reconcile. */
  reference: string | null;
  /** Processor-hosted donation page. Absent = bank transfer only (the default). */
  paymentUrl: string | null;
}

/**
 * Loose by design: this validates SHAPE, not the checksum. A wrong-but-plausible
 * IBAN is the operator's typo to catch on their own bank statement; the point
 * here is to reject an empty string, a placeholder, or a pasted phone number.
 * (BG IBANs are 22 characters; other countries differ, so the length window
 * stays wide rather than pinning Bulgaria into the code.)
 */
const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const BIC_SHAPE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function warn(variable: string, reason: string): void {
  // Value-free on purpose: this line can reach a log aggregator.
  console.warn(`[donations] ${variable} ignored (${reason})`);
}

/** Takes the environment as a plain record so a test can pass one literal. */
type Env = Record<string, string | undefined>;

export function donationDetails(env: Env = process.env): DonationDetails | null {
  const iban = clean(env.DONATION_IBAN).replace(/\s+/g, '').toUpperCase();
  const beneficiary = clean(env.DONATION_BENEFICIARY);
  if (!iban && !beneficiary) return null; // Simply not configured — not an error.

  if (!IBAN_SHAPE.test(iban)) {
    warn('DONATION_IBAN', 'not an IBAN shape');
    return null;
  }
  if (!beneficiary) {
    // An IBAN with no account holder is a transfer that gets returned.
    warn('DONATION_BENEFICIARY', 'missing while DONATION_IBAN is set');
    return null;
  }

  const bicRaw = clean(env.DONATION_BIC).replace(/\s+/g, '').toUpperCase();
  let bic: string | null = null;
  if (bicRaw) {
    if (BIC_SHAPE.test(bicRaw)) bic = bicRaw;
    else warn('DONATION_BIC', 'not a BIC shape');
  }

  const paymentRaw = clean(env.DONATION_PAYMENT_URL);
  let paymentUrl: string | null = null;
  if (paymentRaw) {
    // https only: a donation link over http is a downgrade the operator cannot
    // have meant, and this URL is rendered as a call to action.
    if (/^https:\/\/[^\s]+$/.test(paymentRaw) && paymentRaw.length <= 300) paymentUrl = paymentRaw;
    else warn('DONATION_PAYMENT_URL', 'not an https URL');
  }

  const referenceRaw = clean(env.DONATION_REFERENCE);
  const reference = referenceRaw && referenceRaw.length <= 60 ? referenceRaw : null;
  if (referenceRaw && !reference) warn('DONATION_REFERENCE', 'longer than 60 characters');

  return { iban, beneficiary, bic, reference, paymentUrl };
}
