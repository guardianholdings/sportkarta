/**
 * Whether members may GRANT the training-log consents for connected apps (GPS
 * routes, and heart rate — GDPR Art. 9 health data). Ships OFF.
 *
 * The pre-launch audit found both consents live on /trenirovki while nothing in
 * the product could use them: `attachRoute` and `attachMetrics` have no caller,
 * and no Strava, Garmin or Apple Health integration exists. An Art. 9(2)(a)
 * consent must be specific and informed — it has to name the source, the data,
 * the purpose and the retention — and a consent timestamped for processing that
 * is not defined yet is none of those, so it could not be relied on later
 * anyway. The flag belongs to the integration: turn it on in the same change
 * that ships one, together with its own notice on /privacy and a DPIA.
 *
 * WITHDRAWAL IS NEVER GATED. A member who granted a consent before this flag
 * existed can always withdraw it (Art. 7(3): as easy as giving it) — the page
 * keeps the withdraw control for them, and the action refuses only grants.
 */
export function trainingIntegrationsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.TRAINING_INTEGRATIONS_ENABLED?.trim().toLowerCase() === 'true';
}
