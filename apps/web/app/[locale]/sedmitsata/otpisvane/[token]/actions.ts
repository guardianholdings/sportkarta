'use server';

import { getDb } from '@sportkarta/db';
import { redirect } from 'next/navigation';

import { routing } from '@/i18n/routing';
import { unsubscribeByToken } from '@/lib/digest';

/**
 * The actual unsubscribe — a POST, never a GET (see the page's header: mail
 * scanners fetch every link in an inbound message, and a destructive GET would
 * unsubscribe people before they read the mail).
 *
 * Session-less on purpose: the token IS the authorisation, and it cancels
 * exactly one (member, city) subscription.
 *
 * An unknown token is not an error — it is what a second press produces — so it
 * redirects to the "already used" state rather than throwing.
 */
export async function confirmUnsubscribeAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const locale = String(formData.get('locale') ?? routing.defaultLocale);
  const removed = token === '' ? null : await unsubscribeByToken(getDb(), token);

  // Absolute path, and the locale prefix rebuilt by hand: a server action has
  // no request path to resolve a relative redirect against, and localePrefix is
  // 'as-needed' so bg is unprefixed while en is not.
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`;
  // The municipality id rides along so the "done" screen can NAME the city
  // (L-6) — the row it would be read from no longer exists. An id, not a name:
  // nothing a member typed goes into the URL.
  const done = removed ? `ok&m=${String(removed.municipalityId)}` : 'gone';
  redirect(`${prefix}/sedmitsata/otpisvane/${encodeURIComponent(token)}?done=${done}`);
}
