/**
 * The shape the key form's action returns.
 *
 * In its own module rather than beside the action, because a `'use server'`
 * file may export ONLY async functions — a constant there is a build error, and
 * one that surfaces at `next build` rather than at typecheck.
 */
export interface KeyFormState {
  error: string | null;
  /**
   * The plaintext key, present ONLY on the response that created it. It is
   * rendered once and never stored anywhere we can read back — the database
   * holds a SHA-256 whose column shape cannot even hold the key (0015).
   */
  issued: { key: string; label: string } | null;
}

export const EMPTY_KEY_STATE: KeyFormState = { error: null, issued: null };
