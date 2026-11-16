/**
 * Path segments that are a person or a bearer token, never a page.
 *
 * An invite link, an unsubscribe link, a check-in token, a calendar feed token
 * or a public passport handle identifies a person or grants a capability. The
 * server-side error reporter already sends only the route template
 * (lib/src/error-report); the two things that run in the BROWSER — the Umami
 * tracker and the GlitchTip (Sentry) SDK — see the concrete address, so both
 * pass it through this list first. The sources are plain ES2017 regex text (no
 * lookbehind) because the Umami hook ships as an inline script string that
 * tests/umami-snippet.test.ts runs verbatim.
 *
 * Adding a tokenised route = adding it here; tests/tokenised-paths.test.ts
 * walks the app directory for `[token]` / `[handle]` segments and fails when
 * one is not covered.
 */
export const TOKENISED_PATH_SOURCES: readonly string[] = [
  // /otmetka/<token>, /s/<token>, /pasport/<handle>, /sedmitsata/otpisvane/<token>,
  // /klubove/{otpisvane,pokana,otmetka}/<token>, /api/digest/unsubscribe/<token>,
  // /api/clubs/otpisvane/<token> — each optionally under /en.
  '(\\/(?:en\\/)?(?:otmetka|s|pasport|sedmitsata\\/otpisvane|klubove\\/(?:otpisvane|pokana|otmetka)|api\\/digest\\/unsubscribe|api\\/clubs\\/otpisvane)\\/)[^\\/?#]+',
  // /kalendar/<token> (a member's private feed) but not the public
  // /kalendar/igra/<name> and /kalendar/klub-sabitie/<name> downloads.
  '(\\/kalendar\\/)(?!igra\\/|klub-sabitie\\/)[^\\/?#]+',
  // /klub/<slug>/skan/<token> (a desk check-in token).
  '(\\/(?:en\\/)?klub\\/[^\\/?#]+\\/skan\\/)[^\\/?#]+',
  // /og/lichen/<locale>/pasport/<handle> (a person's own share card).
  '(\\/og\\/lichen\\/[a-z]{2}\\/pasport\\/)[^\\/?#]+',
];

export const TOKEN_PLACEHOLDER = '[token]';

const PATTERNS = TOKENISED_PATH_SOURCES.map((source) => new RegExp(source, 'g'));

/** `/otmetka/abc…` → `/otmetka/[token]`; everything else unchanged. */
export function scrubTokenisedPath(value: string): string {
  let out = value;
  for (const pattern of PATTERNS) out = out.replace(pattern, `$1${TOKEN_PLACEHOLDER}`);
  return out;
}
