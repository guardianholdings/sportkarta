'use server';

import { getDb } from '@sportkarta/db';
import {
  CLUB_PAYMENT_METHODS,
  parseEuroCents,
  sofiaToday,
  type ClubPaymentMethod,
} from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';

import { requireClubStaff } from '@/lib/clubs/club-session';
import { parseCharge, parsePayment } from '@/lib/clubs/input';
import { refundOnlinePayment } from '@/lib/clubs/payments';
import { refundsDue } from '@/lib/clubs/reservations';
import { createCharge, recordPayment, refundPaid } from '@/lib/clubs/sales';

/** How money goes back at the desk: never as credit — that part goes back by itself. */
const MONEY_METHODS = CLUB_PAYMENT_METHODS.filter(
  (m): m is Exclude<ClubPaymentMethod, 'wallet'> => m !== 'wallet',
);

export interface PaymentState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
}

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function refresh(slug: string): void {
  revalidatePath(`/klub/${slug}/plashtaniya`);
  revalidatePath(`/klub/${slug}/chlenove`);
  revalidatePath(`/klub/${slug}/tablo`);
}

export async function recordPaymentAction(
  _prev: PaymentState,
  formData: FormData,
): Promise<PaymentState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'payments.record');
  const parsed = parsePayment(formData, sofiaToday());
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const result = await recordPayment(getDb(), actor, parsed.value);
  if (!result.ok) return { error: result.error === 'not_allowed' ? 'readOnly' : result.error };
  refresh(slug);
  return { error: null, saved: true };
}

export async function createChargeAction(
  _prev: PaymentState,
  formData: FormData,
): Promise<PaymentState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'payments.record');
  const today = sofiaToday();
  const parsed = parseCharge(formData, today);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const chargeId = await createCharge(getDb(), actor, parsed.value, today, 'other');
  if (!chargeId) return { error: 'readOnly' };
  refresh(slug);
  return { error: null, saved: true };
}

/**
 * Refund an online payment through the provider (0046) — all of it, or the
 * amount typed. charges.void (owner, manager); the SQL checks it again.
 */
export async function refundOnlineAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'charges.void');
  const paymentId = Number(formData.get('paymentId'));
  const amountRaw = String(formData.get('amount') ?? '').trim();
  const amount = amountRaw === '' ? null : parseEuroCents(amountRaw);
  let outcome = 'refund_invalid';
  if (Number.isSafeInteger(paymentId) && paymentId > 0 && (amountRaw === '' || amount !== null)) {
    const result = await refundOnlinePayment(getDb(), actor, paymentId, amount);
    outcome = result.ok ? 'refunded' : `refund_${result.error}`;
  }
  refresh(slug);
  redirect({
    href: { pathname: `/klub/${slug}/plashtaniya`, query: { rezultat: outcome } },
    locale: await getLocale(),
  });
}

/**
 * Record the refund of a paid booking cancelled in time (0048). The amount is
 * what the books say was paid on it — never a typed one — and the method is
 * how the money went back. Money paid online goes back through the provider,
 * from its row in the ledger, instead.
 */
export async function refundReservationAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'payments.record');
  const reservationId = String(formData.get('reservationId') ?? '');
  const method = String(formData.get('method') ?? '');
  const due = (await refundsDue(actor)).find((row) => row.reservationId === reservationId);
  let outcome = 'refund_invalid';
  if (due && !due.online && (MONEY_METHODS as readonly string[]).includes(method)) {
    // Credit spent on the booking goes back to the credit; the money by `method`.
    const result = await refundPaid(getDb(), actor, {
      chargeId: due.chargeId,
      method: method as (typeof MONEY_METHODS)[number],
      receivedOn: sofiaToday(),
    });
    outcome = result.ok
      ? 'refunded'
      : result.error === 'invoice_live'
        ? 'refund_invoice_live'
        : 'refund_not_allowed';
  }
  refresh(slug);
  redirect({
    href: { pathname: `/klub/${slug}/plashtaniya`, query: { rezultat: outcome } },
    locale: await getLocale(),
  });
}
