'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { isUuid, parseCreditReason, parseInvoiceBuyer } from '@/lib/clubs/input';
import { issueCreditNote, issueInvoice } from '@/lib/clubs/invoices';

/**
 * Invoices and credit notes (0050). invoices.issue (owner, manager) on a tier
 * with invoices and the shop switch on; every statement scopes itself again.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function issueInvoiceAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'invoices.issue');
  const chargeId = str(formData, 'chargeId');
  const locale = await getLocale();
  const back = (rezultat: string) =>
    redirect({
      href: { pathname: `/klub/${slug}/fakturi/nova`, query: { zadalzhenie: chargeId, rezultat } },
      locale,
    });
  if (!isUuid(chargeId)) return back('not_found');
  if (!featureOn(club, 'invoices')) return back('feature_unavailable');
  const buyer = parseInvoiceBuyer(formData);
  if (!buyer.ok) return back(buyer.errors[0] ?? 'invalid');
  const result = await issueInvoice(getDb(), actor, { chargeId, buyer: buyer.value });
  if (!result.ok) return back(result.error);
  revalidatePath(`/klub/${slug}/fakturi`);
  return redirect({
    href: { pathname: `/klub/${slug}/fakturi/${result.invoiceId}`, query: { rezultat: 'issued' } },
    locale,
  });
}

export async function creditNoteAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'invoices.issue');
  const invoiceId = str(formData, 'invoiceId');
  const locale = await getLocale();
  const reason = parseCreditReason(formData);
  const back = (rezultat: string) =>
    redirect({
      href: {
        pathname: `/klub/${slug}/fakturi/${isUuid(invoiceId) ? invoiceId : ''}`,
        query: { rezultat },
      },
      locale,
    });
  if (!isUuid(invoiceId)) return back('not_found');
  if (reason === null) return back('reason_required');
  const result = await issueCreditNote(getDb(), actor, invoiceId, reason);
  if (!result.ok) return back(result.error);
  revalidatePath(`/klub/${slug}/fakturi`);
  return redirect({
    href: {
      pathname: `/klub/${slug}/fakturi/${result.invoiceId}`,
      query: { rezultat: 'credited' },
    },
    locale,
  });
}
