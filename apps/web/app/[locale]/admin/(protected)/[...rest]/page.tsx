import { notFound } from 'next/navigation';

/**
 * Catch-all so that a NONEXISTENT admin path answers exactly like a HIDDEN
 * one: both run the admin layout's role gate first and then 404 with the same
 * localized not-found page, so a probe learns that /admin exists (the sign-in
 * redirect already says so) and nothing else. This used to matter for the
 * STATUS as well — while a loading boundary sat above every page, a matched
 * admin route streamed a 200 before its gate could 404, and only unmatched
 * paths returned a real 404. No loading boundary sits above /admin now, so
 * both are real 404s; the e2e role-boundary suites assert the equivalence
 * against a random /admin/* path.
 */
export default function AdminCatchAll(): never {
  notFound();
}
