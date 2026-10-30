import { THREAD_BODY_MAX } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ThreadMessages } from '@/components/clubs/thread-messages';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { threadForStaff } from '@/lib/clubs/inbox';
import { isUuid } from '@/lib/clubs/input';
import { formatDate } from '@/lib/format';
import { formErrorText } from '@/lib/clubs/form-error';

import { closeThreadAction, replyAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * One conversation (0052): the messages, the answer box, and «Приключи».
 * Opening it marks it read for the club. The member is told by e-mail or a
 * notification that the club answered — never what it said.
 */
export default async function ClubThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string; threadId: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, threadId } = await params;
  setRequestLocale(locale);
  if (!isUuid(threadId)) notFound();
  const { actor } = await requireClubStaff(slug, 'inbox.reply');
  const thread = await threadForStaff(actor, threadId);
  if (!thread) notFound();
  const [t, messages] = await Promise.all([getTranslations('ClubInbox'), clubFormMessages()]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const good = rezultat !== undefined && t.has(`outcome.${rezultat}`);

  return (
    <main className="space-y-5">
      <Link
        href={`/klub/${slug}/vhodyashti`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        {t('back')}
      </Link>
      <div className="space-y-1.5">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{thread.subject}</h1>
        <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-soft">
          {actorCan(actor, 'members.view') ? (
            <Link
              href={`/klub/${slug}/chlenove/${thread.memberId}`}
              className="font-semibold text-link hover:text-link-hover"
            >
              {thread.memberName}
            </Link>
          ) : (
            <span className="font-semibold text-ink">{thread.memberName}</span>
          )}
          {thread.kind === 'inquiry' && <Badge tone="neutral">{t('inquiryBadge')}</Badge>}
          {thread.closed && <Badge tone="neutral">{t('closed')}</Badge>}
        </p>
        {thread.kind === 'inquiry' && thread.inquiryKind && (
          <p className="text-body-sm text-ink">
            {[
              t(`kinds.${thread.inquiryKind}`),
              thread.inquiryOn ? t('onDate', { date: formatDate(thread.inquiryOn, locale) }) : null,
              thread.partySize !== null ? t('party', { count: thread.partySize }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </div>

      {rezultat && (
        <p
          role="status"
          className={
            good
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {good
            ? t(`outcome.${rezultat}`)
            : rezultat === 'readOnly'
              ? messages.readOnly
              : formErrorText(messages, rezultat)}
        </p>
      )}

      {!thread.memberLinked && (
        <p className="rounded-card border border-warning-border bg-warning-bg p-3 text-body-sm text-ink">
          {t('notLinked')}
        </p>
      )}

      <section className={section} aria-label={t('conversation')}>
        <ThreadMessages
          messages={thread.messages}
          viewer="club"
          locale={locale}
          labels={{ member: thread.memberName, club: '', formerStaff: t('formerStaff') }}
        />
      </section>

      <section className={section} aria-labelledby="reply-h">
        <h2 id="reply-h" className="text-h4 font-bold text-ink">
          {t('replyTitle')}
        </h2>
        <form action={replyAction} className="space-y-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="threadId" value={thread.id} />
          <label className="block text-body-sm font-semibold text-ink">
            {t('replyLabel')}
            <Textarea
              name="body"
              required
              maxLength={THREAD_BODY_MAX}
              rows={5}
              size="sm"
              className="mt-1"
            />
            <span className="mt-1 block text-caption font-normal text-text-muted">
              {t('replyHint')}
            </span>
          </label>
          <Button type="submit">{t('send')}</Button>
        </form>
        <form action={closeThreadAction}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="threadId" value={thread.id} />
          <input type="hidden" name="closed" value={thread.closed ? 'false' : 'true'} />
          <Button type="submit" variant="secondary" size="sm">
            {thread.closed ? t('reopen') : t('close')}
          </Button>
        </form>
      </section>
    </main>
  );
}
