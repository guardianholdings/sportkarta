import { THREAD_BODY_MAX, THREAD_SUBJECT_MAX } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { memberThreads } from '@/lib/clubs/inbox';
import { portalView } from '@/lib/clubs/portal';
import { formatDateTime } from '@/lib/format';

import { memberWriteAction } from './actions';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubInbox' });
  return { title: t('portal.title'), robots: { index: false, follow: false } };
}

/**
 * The member's conversations with their club (0052): the list, unread
 * first, and a new message. Only for the account's own linked record.
 */
export default async function PortalMessagesPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const user = await requireUser();
  const view = await portalView(user.id, slug, locale);
  if (!view || view.link?.status !== 'active') notFound();
  const [t, messages, threads] = await Promise.all([
    getTranslations('ClubInbox'),
    clubFormMessages(),
    memberThreads(user.id, view.club.id),
  ]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-5 p-4">
        <header className="space-y-1 border-b border-line pb-3">
          <Link
            href={`/klub/${slug}/az`}
            className="text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {view.club.name}
          </Link>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('portal.title')}</h1>
          <p className="text-body-sm text-ink-soft">{t('portal.intro')}</p>
        </header>

        {rezultat && rezultat !== 'sent' && (
          <p
            role="status"
            className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
          >
            {rezultat === 'readOnly'
              ? messages.readOnly
              : (messages.errors[rezultat] ?? messages.genericError)}
          </p>
        )}

        <section className={section} aria-labelledby="threads-h">
          <h2 id="threads-h" className="text-h4 font-bold text-ink">
            {t('portal.listTitle')}
          </h2>
          {threads.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('portal.empty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {threads.map((thread) => (
                <li key={thread.id} className="py-2">
                  <Link
                    href={`/klub/${slug}/az/saobshteniya/${thread.id}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                  >
                    <span
                      className={`min-w-0 flex-1 text-body-sm text-ink ${
                        thread.unread ? 'font-bold' : 'font-semibold'
                      }`}
                    >
                      {thread.subject}
                    </span>
                    {thread.unread && <Badge tone="brand">{t('unread')}</Badge>}
                    <time dateTime={thread.lastAt} className="text-caption text-text-muted">
                      {formatDateTime(thread.lastAt, locale)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {view.club.live && (
          <section className={section} aria-labelledby="new-h">
            <h2 id="new-h" className="text-h4 font-bold text-ink">
              {t('portal.newTitle')}
            </h2>
            <form action={memberWriteAction} className="space-y-3">
              <input type="hidden" name="slug" value={slug} />
              <label className={field}>
                {t('subject')}
                <Input
                  name="subject"
                  required
                  maxLength={THREAD_SUBJECT_MAX}
                  size="sm"
                  className="mt-1"
                />
              </label>
              <label className={field}>
                {t('body')}
                <Textarea
                  name="body"
                  required
                  maxLength={THREAD_BODY_MAX}
                  rows={5}
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
