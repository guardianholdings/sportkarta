/**
 * Which payment provider runs — resolved from the environment, FAILING CLOSED
 * like resolveMailTransport (lib/src/email/mailer.ts):
 *
 *   stripe    PAYMENT_PROVIDER=stripe and all three Stripe settings present.
 *   fake      a local stand-in (/dev/plashtane) for development and e2e; it
 *             can never resolve in production.
 *   disabled  anything else — online payment buttons are not offered.
 *
 * In development an unset PAYMENT_PROVIDER means `fake`, so the whole flow is
 * walkable without a Stripe account; in production it means `disabled`.
 */

export type PaymentProviderKind = 'stripe' | 'fake' | 'disabled';

export interface StripeSettings {
  secretKey: string;
  webhookSecret: string;
  connectClientId: string;
  /** Platform fee in basis points of each payment (0 = none). */
  applicationFeeBp: number;
}

type Env = Record<string, string | undefined>;

function value(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

export function resolvePaymentProvider(env: Env): PaymentProviderKind {
  const production = env.NODE_ENV === 'production';
  const requested = value(env, 'PAYMENT_PROVIDER').toLowerCase();
  if (requested === 'stripe') return stripeSettings(env) ? 'stripe' : 'disabled';
  if (requested === 'fake' || (requested === '' && !production)) {
    return production ? 'disabled' : 'fake';
  }
  return 'disabled';
}

export function stripeSettings(env: Env): StripeSettings | null {
  const secretKey = value(env, 'STRIPE_SECRET_KEY');
  const webhookSecret = value(env, 'STRIPE_WEBHOOK_SECRET');
  const connectClientId = value(env, 'STRIPE_CONNECT_CLIENT_ID');
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(secretKey)) return null;
  if (!/^whsec_[A-Za-z0-9]{10,}$/.test(webhookSecret)) return null;
  if (!/^ca_[A-Za-z0-9]{10,}$/.test(connectClientId)) return null;
  const feeRaw = value(env, 'STRIPE_APPLICATION_FEE_BP');
  const fee = /^\d{1,4}$/.test(feeRaw) ? Math.min(Number(feeRaw), 2000) : 0;
  return { secretKey, webhookSecret, connectClientId, applicationFeeBp: fee };
}

/** The platform fee for an amount, rounded down to a cent; never above the amount. */
export function applicationFeeCents(amountCents: number, feeBp: number): number {
  if (feeBp <= 0) return 0;
  return Math.min(amountCents, Math.floor((amountCents * feeBp) / 10_000));
}
