import { LEAD_LOST_REASONS, sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations } from 'next-intl/server';

import { leadAction } from '@/app/[locale]/klub/[slug]/(office)/chlenove/potentsialni/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import type { LeadCard } from '@/lib/clubs/leads';
import { formatDate } from '@/lib/format';

/**
 * One prospect (0052): who, from where, since when, the next step and its
 * owner — and the few things the desk decides: called, next step, lost,
 * back, off the board. The stage itself moves by the books (a trial, a
 * visit, a sale); nothing here sets it.
 */
export async function LeadCardView({
  slug,
  card,
  owners,
  locale,
  canManage,
  from,
}: {
  slug: string;
  card: LeadCard;
  owners: { userId: string; name: string }[];
  locale: string;
  canManage: boolean;
  /** The member page posts back to itself. */
  from?: 'member';
}) {
  const t = await getTranslations('ClubLeads');
  const open = card.stage === 'new' || card.stage === 'contacted';
  const hidden = (op: string) => (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="memberId" value={card.memberId} />
      <input type="hidden" name="op" value={op} />
      {from && <input type="hidden" name="from" value={from} />}
    </>
  );
  const field = 'block text-caption font-semibold text-ink';
  const select =
    'mt-1 block min-h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-body-sm text-ink';

  return (
    <article className="space-y-2 rounded-card border border-line bg-surface p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`/klub/${slug}/chlenove/${card.memberId}`}
          className="text-body-sm font-bold text-ink underline-offset-2 hover:underline"
        >
          {card.name}
        </Link>
        <span className="flex flex-wrap gap-1.5">
          {card.due && <Badge tone="warning">{t('due')}</Badge>}
          <Badge tone="neutral">{t(`stage.${card.stage}`)}</Badge>
        </span>
      </div>
      <p className="text-caption text-text-muted">
        {[
          card.source ? t(`source.${card.source}`) : null,
          t('since', { date: formatDate(card.openedAt, locale) }),
          card.contactedAt
            ? t('contactedOn', { date: formatDate(card.contactedAt, locale) })
            : null,
          card.nextActionOn ? t('nextOn', { date: formatDate(card.nextActionOn, locale) }) : null,
          card.assignedName ? t('owner', { name: card.assignedName }) : null,
          card.lostReason ? t(`lost.${card.lostReason}`) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm">
        {card.phone && (
          <a href={`tel:${card.phone}`} className="text-link">
            {card.phone}
          </a>
        )}
        {card.email && (
          <a href={`mailto:${card.email}`} className="text-link">
            {card.email}
          </a>
        )}
        {card.threadId && (
          <Link href={`/klub/${slug}/vhodyashti/${card.threadId}`} className="text-link">
            {t('conversation')}
          </Link>
        )}
      </p>
      {canManage && (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center text-body-sm font-semibold text-link">
            {t('actions')}
          </summary>
          <div className="mt-2 space-y-3">
            {open && card.contactedAt === null && (
              <form action={leadAction}>
                {hidden('contacted')}
                <Button type="submit" size="sm">
                  {t('markContacted')}
                </Button>
              </form>
            )}
            {card.stage !== 'lost' && card.stage !== 'won' && (
              <form
                action={leadAction}
                className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
              >
                {hidden('plan')}
                <label className={field}>
                  {t('nextAction')}
                  <Input
                    type="date"
                    name="nextActionOn"
                    min={sofiaToday()}
                    defaultValue={card.nextActionOn ?? ''}
                    size="sm"
                    className="mt-1"
                  />
                </label>
                <label className={field}>
                  {t('assignTo')}
                  <select name="assignedTo" defaultValue={card.assignedTo ?? ''} className={select}>
                    <option value="">{t('nobody')}</option>
                    {owners.map((owner) => (
                      <option key={owner.userId} value={owner.userId}>
                        {owner.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button type="submit" size="sm" variant="secondary">
                  {t('savePlan')}
                </Button>
              </form>
            )}
            {card.stage !== 'lost' && card.stage !== 'won' && (
              <form action={leadAction} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                {hidden('lost')}
                <label className={field}>
                  {t('lostReason')}
                  <select name="reason" required defaultValue="" className={select}>
                    <option value="" disabled>
                      {t('choose')}
                    </option>
                    {LEAD_LOST_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {t(`lost.${reason}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button type="submit" size="sm" variant="secondary">
                  {t('markLost')}
                </Button>
              </form>
            )}
            {card.stage === 'lost' && (
              <form action={leadAction}>
                {hidden('reopen')}
                <Button type="submit" size="sm" variant="secondary">
                  {t('reopen')}
                </Button>
              </form>
            )}
            <form action={leadAction}>
              {hidden('remove')}
              <Button type="submit" size="sm" variant="ghost">
                {t('remove')}
              </Button>
            </form>
          </div>
        </details>
      )}
    </article>
  );
}
