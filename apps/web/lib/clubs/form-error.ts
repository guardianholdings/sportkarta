import type { ClubFormMessages } from './form-labels';

/**
 * The message for an error code — an OWN key of the catalogue only. Pages look
 * codes up straight from `?rezultat=`, and `constructor` or `toString` must
 * miss like any unknown code, not return a function for React to choke on.
 * (The catalogue itself stays a plain object: a null-prototype one cannot
 * cross into a client component.) Client-safe: no server import.
 */
export function formErrorText<F extends string | null = string>(
  messages: ClubFormMessages,
  code: string,
  fallback?: F,
): string | F {
  if (Object.hasOwn(messages.errors, code)) return messages.errors[code] as string;
  return fallback === undefined ? messages.genericError : fallback;
}

/**
 * A result code a page may look up in a NAMESPACE's own messages
 * (`t.has(\`error.${code}\`)`): lower-case and not a name every object
 * inherits — next-intl walks `messages[part]`, so `constructor` would find
 * Object itself.
 */
export function isPlainCode(code: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) && !(code in Object.prototype);
}
