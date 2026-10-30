'use server';

import { getDb } from '@sportkarta/db';
import { sofiaToday } from '@sportkarta/lib/clubs';
import { getLocale, getTranslations } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { inquiryTarget, sendInquiry } from '@/lib/clubs/inbox';
import { parseInquiry } from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';

/**
 * An inquiry from the club's public page (0052): signed in, about a hall,
 * an event, a group, a party or a camp. The person's own record at the
 * club is found or created (the trial booking's path), the thread opened, a
 * prospect put on the desk's pipeline, and the staff told after the commit.
 */
export async function inquiryAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const slugRaw = formData.get('slug');
  const slug = typeof slugRaw === 'string' && /^[a-z0-9-]{3,60}$/.test(slugRaw) ? slugRaw : '';
  const locale = await getLocale();
  const back = (rezultat: string, thread?: string): never =>
    redirect({
      // `thread` is a uuid from the insert — never caller text.
      href: `/klub/${slug}/zapitvane?rezultat=${rezultat}${thread ? `&razgovor=${thread}` : ''}`,
      locale,
    });
  const club = await inquiryTarget(slug, locale);
  if (!club || !club.open) return back('readOnly');
  const parsed = parseInquiry(formData, sofiaToday());
  if (!parsed.ok) return back(parsed.errors[0] ?? 'invalid');
  const t = await getTranslations({ locale: club.clubLocale, namespace: 'ClubInbox' });
  const result = await sendInquiry(
    getDb(),
    user.id,
    club.id,
    parsed.value,
    t(`kinds.${parsed.value.kind}`),
  );
  if (!result.ok) return back(result.error);
  await enqueueClubNotify({ kind: 'inbox_message', messageId: result.messageId });
  return back('sent', result.threadId);
}
