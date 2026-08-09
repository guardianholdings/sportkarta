import { notFound } from 'next/navigation';

/**
 * Catch-all so that a NONEXISTENT admin path answers exactly like a HIDDEN
 * one. Since the root loading boundary landed, a matched admin route streams
 * its 200 shell before requireRole() can 404 — but an unmatched path never
 * streamed and still returned a real 404, and that asymmetry let anyone
 * enumerate which admin screens exist by status code alone. With this route
 * every /admin/* URL matches, streams the same shell, and renders the same
 * not-found UI: a probe learns that /admin exists (the sign-in redirect
 * already says so) and nothing else. The e2e role-boundary suites assert
 * this equivalence against a random /admin/* path.
 */
export default function AdminCatchAll(): never {
  notFound();
}
