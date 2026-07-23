import 'server-only';

/**
 * The QR check-in secret (docs/ROADMAP.md §7, Stage 5.4).
 *
 * Read at REQUEST time rather than at module load, so the container environment
 * applies without a rebuild — the same rule the Umami and GlitchTip settings
 * follow in the [locale] layout.
 *
 * UNSET MEANS THE FEATURE IS OFF, not that everything verifies. Both the issuer
 * and the verifier treat an empty secret as "no token can be valid", so a
 * deployment that forgets this variable loses QR check-in and scoring, and
 * gains nothing it should not have. That is the fail-closed direction: the
 * alternative — signing with an empty string — would make a forged token
 * trivially constructible by anybody who read this repository.
 */
export function checkinSecret(): string | undefined {
  const secret = process.env.CHECKIN_TOKEN_SECRET?.trim();
  // A short secret is worse than none: it looks configured. 32 characters is
  // the length .env.example documents and what `openssl rand -base64 24` gives.
  if (!secret || secret.length < 32) return undefined;
  return secret;
}

export function isCheckinEnabled(): boolean {
  return checkinSecret() !== undefined;
}
