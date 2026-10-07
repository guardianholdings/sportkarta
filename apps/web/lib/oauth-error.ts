import { isSignInProvider, type SignInProvider } from './sign-in-providers';

/**
 * What /vhod says when a provider sends a visitor back with `?error=`.
 *
 * The code comes from better-auth or straight from the provider (the query is
 * the visitor's to edit), so it is only ever MAPPED onto one of four messages,
 * never echoed.
 */

export type OAuthErrorKind = 'account_not_linked' | 'email_not_found' | 'cancelled' | 'failed';

export interface OAuthError {
  kind: OAuthErrorKind;
  /** null when the provider in the URL is missing or not one of ours. */
  provider: SignInProvider | null;
}

/** "The visitor said no": Google and Facebook send access_denied, Apple its own. */
const CANCELLED = new Set(['access_denied', 'user_cancelled_authorize', 'user_denied']);

export function parseOAuthError(error: unknown, provider: unknown): OAuthError | null {
  if (typeof error !== 'string' || error === '') return null;
  const named = isSignInProvider(provider) ? provider : null;
  if (error === 'account_not_linked') return { kind: 'account_not_linked', provider: named };
  if (error === 'email_not_found') return { kind: 'email_not_found', provider: named };
  if (CANCELLED.has(error)) return { kind: 'cancelled', provider: named };
  return { kind: 'failed', provider: named };
}
