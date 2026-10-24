'use server';

import { getDb } from '@sportkarta/db';
import { sofiaToday } from '@sportkarta/lib/clubs';
import { revalidatePath } from 'next/cache';

import { requireClubStaff } from '@/lib/clubs/club-session';
import { parseCharge, parsePayment } from '@/lib/clubs/input';
import { createCharge, recordPayment } from '@/lib/clubs/sales';

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
