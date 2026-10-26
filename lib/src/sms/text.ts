/**
 * SMS text arithmetic (wave F, 0051) — pure, so a client component may import
 * it (`@sportkarta/lib/sms/text`) to count parts while staff type.
 *
 * A GATEWAY CHARGES PER PART, and how many characters fit in a part depends on
 * the alphabet: a message entirely in the GSM 03.38 alphabet carries 160
 * characters in one part and 153 in each part of a longer one; ANY character
 * outside it — every Cyrillic letter — switches the whole message to UCS-2, 70
 * and 67. A Bulgarian SMS is therefore almost always UCS-2, and a 160-letter
 * Bulgarian message is three parts, not one. `smsParts` is what the ledger
 * records (club_notifications.sms_parts) and what the cap counts.
 */

/** GSM 03.38 basic character set (one septet each). */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** The extension table: each costs an escape plus the character (two septets). */
const GSM_EXTENDED = new Set('^{}\\[~]|€');

/** The most parts one club message may take (a long one is a mistake, and costs). */
export const SMS_MAX_PARTS = 5;

export type SmsEncoding = 'gsm7' | 'ucs2';

export interface SmsLength {
  encoding: SmsEncoding;
  /** Septets (GSM) or UTF-16 code units (UCS-2). */
  units: number;
  parts: number;
}

export function smsLength(text: string): SmsLength {
  let septets = 0;
  let gsm = true;
  for (const char of text) {
    if (GSM_BASIC.has(char)) septets += 1;
    else if (GSM_EXTENDED.has(char)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return { encoding: 'gsm7', units: septets, parts: partsFor(septets, 160, 153) };
  }
  // UTF-16 code units: an emoji is two.
  return { encoding: 'ucs2', units: text.length, parts: partsFor(text.length, 70, 67) };
}

function partsFor(units: number, single: number, multi: number): number {
  if (units === 0) return 1;
  return units <= single ? 1 : Math.ceil(units / multi);
}

export function smsParts(text: string): number {
  return smsLength(text).parts;
}

/**
 * A phone number as E.164 (`+359888123456`), or null when it cannot be one.
 * Bulgarian habits first: a leading `0` is the national trunk prefix
 * (0888 123 456 → +359 888 123 456), `00` is the international one, and a bare
 * `359…` already carries the country. Spaces, dashes, dots and brackets are
 * dropped; anything else makes the number unusable rather than guessed at.
 */
export function toE164(raw: string, countryCode = '359'): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, '');
  let digits: string;
  if (compact.startsWith('+')) digits = compact.slice(1);
  else if (compact.startsWith('00')) digits = compact.slice(2);
  else if (compact.startsWith('0')) digits = countryCode + compact.slice(1);
  else if (compact.startsWith(countryCode)) digits = compact;
  else return null;
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  // A national number whose trunk zero was typed after the country code
  // (+359 0888 …) is a common slip; it is not a valid number as written.
  if (digits.startsWith(`${countryCode}0`)) return null;
  return `+${digits}`;
}
