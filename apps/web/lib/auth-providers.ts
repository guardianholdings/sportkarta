import type { SignInProviderStates } from './auth-config';
import { appleClientSecretSource } from './apple-client-secret';

/**
 * Google, Apple and Facebook sign-in (Boss decision #31), as better-auth
 * options. Each ships OFF behind its own flag (lib/auth-config.ts); this module
 * only shapes the providers that are on, and the policies every one of them
 * shares:
 *
 *  - ONE PERSON, ONE ACCOUNT. A provider sign-in whose address matches an
 *    existing account signs into that account only when the provider vouches
 *    for the address (Google's and Apple's email_verified claim) AND the
 *    account's own address is already proven. No provider is trusted by name.
 *    Facebook never vouches (better-auth marks every Meta address unverified),
 *    so a Facebook sign-in never merges into an existing account — decision
 *    (a) — and the visitor gets one clear line on /vhod instead.
 *
 *  - NOTHING BEYOND THE SIGN-IN. We keep the address and the provider's
 *    account ID. The provider's name and photo are not copied into the
 *    profile — the display name stays the member's own choice, exactly as with
 *    the email code — and no access, refresh or ID token is stored: POPS never
 *    calls a provider on a member's behalf, so it has no use for one.
 *
 *  - EVERY FAILURE LANDS ON /vhod. better-auth's default is its own bare
 *    /api/auth/error page; the sign-in actions pass a locale-aware
 *    errorCallbackURL and this is the fallback for a callback whose state is
 *    gone.
 */

/** Apple answers with a form POST from this origin (response_mode=form_post). */
export const APPLE_ORIGIN = 'https://appleid.apple.com';

/** What a provider profile contributes to the users row: nothing but the address. */
function addressOnly() {
  return { name: '', image: undefined };
}

export function socialProviderOptions(states: SignInProviderStates) {
  const { google, apple, facebook } = states;
  return {
    ...(google.enabled
      ? {
          google: {
            clientId: google.clientId,
            clientSecret: google.clientSecret,
            mapProfileToUser: addressOnly,
          },
        }
      : {}),
    ...(apple.enabled
      ? {
          apple: appleProviderOptions(
            appleClientSecretSource({
              clientId: apple.clientId,
              teamId: apple.teamId,
              keyId: apple.keyId,
              key: apple.privateKey,
            }),
            apple.clientId,
          ),
        }
      : {}),
    ...(facebook.enabled
      ? {
          facebook: {
            clientId: facebook.clientId,
            clientSecret: facebook.clientSecret,
            // better-auth's defaults are exactly `email` and `public_profile`;
            // nothing is added, and the Graph fields stay id, name, email,
            // picture (of which only id and email are kept).
            mapProfileToUser: addressOnly,
          },
        }
      : {}),
  };
}

/**
 * The client secret is a GETTER: better-auth keeps this object and reads
 * `clientSecret` on every token request, so each request carries a JWT minted
 * within the last hour (tests/auth-providers-flow.test.ts proves it through a
 * real better-auth instance, so an upgrade that starts copying the options
 * fails there, not in production an hour after a deploy).
 */
function appleProviderOptions(secret: () => string, clientId: string) {
  return {
    clientId,
    get clientSecret(): string {
      return secret();
    },
    // The ID token's audience is checked against clientId (the Services ID),
    // better-auth's default for the web.
    mapProfileToUser: addressOnly,
  };
}

/** Apple's form POST must pass the origin check; nobody else is added. */
export function trustedOriginsFor(states: SignInProviderStates): string[] {
  return states.apple.enabled ? [APPLE_ORIGIN] : [];
}

/**
 * `account` options. requireLocalEmailVerified is better-auth's default,
 * pinned so an upgrade cannot quietly relax it: it is what stops a Google
 * sign-in from attaching itself to an account somebody opened with an address
 * they never proved. No provider is trusted by name (trustedProviders is
 * empty): each must vouch for the address on every sign-in.
 */
export function accountOptions() {
  return {
    modelName: 'accounts',
    // Nothing to refresh: no tokens are kept (see stripProviderTokens).
    updateAccountOnSignIn: false,
    accountLinking: {
      enabled: true,
      trustedProviders: [] as string[],
      requireLocalEmailVerified: true,
      allowDifferentEmails: false,
      updateUserInfoOnLink: false,
    },
  };
}

const NO_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
} as const;

/**
 * The accounts row as written: the link (provider, provider account ID, user)
 * and the granted scope, never a token. Used as the account create/update
 * database hook, which every link path goes through (sign-up, implicit link,
 * explicit link).
 */
export function stripProviderTokens<T extends Record<string, unknown>>(account: T) {
  return Promise.resolve({ data: { ...account, ...NO_TOKENS } });
}

/** Where an OAuth failure lands when the visitor's own error URL is unknown. */
export function oauthErrorFallbackUrl(siteBaseUrl: string): string {
  return `${siteBaseUrl.replace(/\/+$/, '')}/vhod`;
}
