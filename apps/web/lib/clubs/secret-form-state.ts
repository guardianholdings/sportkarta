/**
 * What an office form that mints a secret returns (0057): an API key, a
 * webhook signing secret, a door token. The secret is present ONLY on the
 * response that made it — rendered once, never redirected into a URL, never
 * put in a cookie (apps/web/lib/opendata/key-form-state.ts, the same rule).
 *
 * Its own module because a 'use server' file may export only async functions.
 */
export interface SecretFormState {
  /** A ClubForm.error / ClubIntegrations code, or null. */
  error: string | null;
  secret: string | null;
}

export const EMPTY_SECRET_STATE: SecretFormState = { error: null, secret: null };
