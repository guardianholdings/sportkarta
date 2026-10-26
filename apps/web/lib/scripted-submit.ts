/**
 * The field `useFormAction` adds to every submit its script sends
 * (lib/use-form-action.ts). A native form POST — one sent before the page has
 * hydrated — never carries it, so a server action can tell the two apart and
 * answer each the way it can be followed.
 *
 * Why it exists: a server action that ends in `redirect()` back to the page
 * the form is on (/dobavi → /dobavi?saved=hidden…) left a production build of
 * the client router stuck, in 4–5 of 12 e2e runs: either the button stayed on
 * «Изпращаме…» and nothing moved, or the URL changed and the page body stayed
 * empty (2026-10-13, Next 15.5.27; `next dev` never showed it). The server had
 * already answered in full. Redirects to another page (/obekt/…) are not
 * affected. So a scripted submit that lands on its own page gets the URL back
 * and loads it as a new page instead (app/[locale]/dobavi/actions.ts), while a
 * native POST keeps the plain 303, which the browser follows by itself.
 */
export const SCRIPTED_SUBMIT_FIELD = '_scripted';
