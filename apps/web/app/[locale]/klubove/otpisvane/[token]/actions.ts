'use server';

import { getLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { unsubscribe } from '@/lib/clubs/unsubscribe';

/** The human path of the opt-out (mail clients use the one-click POST route). */
export async function unsubscribeAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const tokenRaw = formData.get('token');
  const token = typeof tokenRaw === 'string' ? tokenRaw : '';
  await unsubscribe(token);
  return redirect({
    href: { pathname: `/klubove/otpisvane/${token}`, query: { gotovo: '1' } },
    locale: await getLocale(),
  });
}
