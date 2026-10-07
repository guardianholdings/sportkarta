/**
 * The sign-in providers besides the email code, in the order their buttons
 * appear. Client-safe on purpose (no node: imports): the sign-in form and the
 * privacy page both need the list and the names, while lib/auth-config.ts —
 * which decides which providers are on — pulls in node:crypto for Apple's key.
 */
export const SIGN_IN_PROVIDERS = ['google', 'apple', 'facebook'] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export function isSignInProvider(value: unknown): value is SignInProvider {
  return (SIGN_IN_PROVIDERS as readonly unknown[]).includes(value);
}

/** Each brand as it writes itself, in every language. */
export const SIGN_IN_PROVIDER_NAMES: Readonly<Record<SignInProvider, string>> = {
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
};
