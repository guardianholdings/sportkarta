/**
 * `@sportkarta/lib/payments` — the club module's online payments (plan
 * 2026-10-25, decision 1: each club's OWN Stripe account, hosted Checkout by
 * redirect, no Stripe script on pops.bg, the NGO never holds funds).
 *
 * SERVER-ONLY: node:crypto and the platform's secret key. A client component
 * must never import this subpath (tests/client-imports.test.ts).
 */
export * from './provider.js';
export * from './signature.js';
export * from './stripe.js';
