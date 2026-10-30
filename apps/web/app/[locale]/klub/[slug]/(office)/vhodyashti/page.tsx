import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { chipClass } from '@/components/ui/chip';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { INBOX_FILTERS, listThreads, type InboxFilter } from '@/lib/clubs/inbox';
import { formatDate, formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * «Входящи» (0052, wave F2): the club's conversations with its clients and
 * the inquiries from its public page, unread first. Front of house answers.
 */
export default async function ClubInboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ f?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'inbox.reply');
  const { f } = await searchParams;
  const filter: InboxFilter = (INBOX_FILTERS as readonly string[]).includes(f ?? '')
    ? (f as InboxFilter)
    : 'open';
  const [t, threads] = await Promise.all([
    getTranslations('ClubInbox'),
    listThreads(actor, filter),
  ]);
  const base = `/klub/${slug}/vhodyashti`;

  return (
    <main className="space-y-5">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      <nav aria-label={t('title')} className="-mx-4 overflow-x-auto px-4">
        <ul className="flex gap-2 pb-1">
          {INBOX_FILTERS.map((value) => (
            <li key={value}>
              <Link
                href={{ pathname: base, query: value === 'open' ? {} : { f: value } }}
                aria-current={value === filter ? 'page' : undefined}
                className={chipClass({ selected: value === filter, className: 'min-h-11' })}
              >
                {t(`filters.${value}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        {threads.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {threads.map((thread) => (
              <li key={thread.id} className="py-2.5">
                <Link
                  href={`${base}/${thread.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        thread.unread
                          ? 'block text-body-sm font-bold text-ink'
                          : 'block text-body-sm font-semibold text-ink'
                      }
                    >
                      {thread.memberName}
                      {' — '}
                      {thread.subject}
                    </span>
                    <span className="block text-caption text-text-muted">
                      {thread.kind === 'inquiry' && thread.inquiryKind
                        ? [
                            t(`kinds.${thread.inquiryKind}`),
                            thread.inquiryOn
                              ? t('onDate', { date: formatDate(thread.inquiryOn, locale) })
                              : null,
                            thread.partySize !== null
                              ? t('party', { count: thread.partySize })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : t('message')}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-caption text-text-muted">
                    {thread.unread && <Badge tone="brand">{t('unread')}</Badge>}
                    {thread.kind === 'inquiry' && <Badge tone="neutral">{t('inquiryBadge')}</Badge>}
                    {thread.closed && <Badge tone="neutral">{t('closed')}</Badge>}
                    <time dateTime={thread.lastAt}>{formatDateTime(thread.lastAt, locale)}</time>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
