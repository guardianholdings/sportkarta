import { THREAD_BODY_MAX } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ThreadMessages } from '@/components/clubs/thread-messages';
import { AppShell } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { memberThread } from '@/lib/clubs/inbox';
import { isUuid } from '@/lib/clubs/input';
import { portalView } from '@/lib/clubs/portal';

import { memberWriteAction } from '../actions';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string; threadId: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubInbox' });
  return { title: t('portal.title'), robots: { index: false, follow: false } };
}

/** One conversation with the club, as its member reads it (0052). */
export default async function PortalThreadPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, threadId } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  if (!isUuid(threadId)) notFound();
  const user = await requireUser();
  const view = await portalView(user.id, slug, locale);
  if (!view || view.link?.status !== 'active') notFound();
  const thread = await memberThread(user.id, view.club.id, threadId);
  if (!thread) notFound();
  const [t, messages] = await Promise.all([getTranslations('ClubInbox'), clubFormMessages()]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-5 p-4">
        <header className="space-y-1 border-b border-line pb-3">
          <Link
            href={`/klub/${slug}/az/saobshteniya`}
            className="text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {t('portal.back')}
          </Link>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{thread.subject}</h1>
          <p className="text-body-sm text-ink-soft">{view.club.name}</p>
        </header>

        {rezultat && (
          <p
            role="status"
            className={
              rezultat === 'sent'
                ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
                : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
            }
          >
            {rezultat === 'sent'
              ? t('portal.sent')
              : rezultat === 'readOnly'
                ? messages.readOnly
                : (messages.errors[rezultat] ?? messages.genericError)}
          </p>
        )}

        <section className={section} aria-label={t('conversation')}>
          <ThreadMessages
            messages={thread.messages}
            viewer="member"
            locale={locale}
            labels={{ member: t('portal.you'), club: view.club.name, formerStaff: '' }}
          />
        </section>

        {view.club.live && (
          <section className={section} aria-labelledby="reply-h">
            <h2 id="reply-h" className="text-h4 font-bold text-ink">
              {t('replyTitle')}
            </h2>
            <form action={memberWriteAction} className="space-y-3">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="threadId" value={thread.id} />
              <label className="block text-body-sm font-semibold text-ink">
                {t('replyLabel')}
                <Textarea
                  name="body"
                  required
                  maxLength={THREAD_BODY_MAX}
                  rows={4}
                  size="sm"
                  className="mt-1"
                />
              </label>
              <Button type="submit">{t('send')}</Button>
            </form>
          </section>
        )}
      </main>
    </AppShell>
  );
}
