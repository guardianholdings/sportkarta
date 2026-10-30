import { addDaysIso, composeSms, sofiaToday, type Audience } from '@sportkarta/lib/clubs';
import { smsParts } from '@sportkarta/lib/sms/text';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { clubName, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { broadcastDetail, broadcastReach, channelsOn, clubTagsInUse } from '@/lib/clubs/messages';
import { listPlans } from '@/lib/clubs/sales';
import { listClasses } from '@/lib/clubs/schedule';
import { formatDateTime } from '@/lib/format';
import { siteUrl } from '@/lib/seo';
import { formErrorText } from '@/lib/clubs/form-error';

import {
  cancelBroadcastAction,
  deleteBroadcastAction,
  scheduleBroadcastAction,
  unscheduleBroadcastAction,
} from '../actions';
import { ComposeForm } from '../parts';

export const dynamic = 'force-dynamic';

/**
 * One message (0051): what it says, to whom, how many it reaches today by
 * each channel, and — while it is a draft — sending it now or at a set time.
 * Once scheduled its text is fixed; it can go back to a draft until it starts.
 */
export default async function ClubBroadcastPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string; broadcastId: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, broadcastId } = await params;
  setRequestLocale(locale);
  if (!isUuid(broadcastId)) notFound();
  const { actor, club } = await requireClubStaff(slug, 'messages.send');
  const broadcast = await broadcastDetail(actor, broadcastId);
  if (!broadcast) notFound();
  const [t, tClub, tMembers, messages, plans, classes] = await Promise.all([
    getTranslations('ClubMessages'),
    getTranslations('Club'),
    getTranslations('ClubMembers'),
    clubFormMessages(),
    listPlans(actor, { includeArchived: true }),
    listClasses(actor),
  ]);
  const { rezultat } = await searchParams;
  const open = broadcast.status === 'draft' || broadcast.status === 'scheduled';
  const reach = open ? await broadcastReach(actor, broadcast, club.tier) : null;
  const tags = broadcast.status === 'draft' ? await clubTagsInUse(actor) : [];
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const small = 'text-caption text-ink-soft';
  const name = clubName(club, locale);

  const audienceLabel = (audience: Audience): string => {
    switch (audience.kind) {
      case 'all':
        return t('audience.all');
      case 'segment':
        return tClub(`segment.${audience.segment}`);
      case 'filter':
        return tMembers(`filter.${audience.filter}`);
      case 'tag':
        return t('audience.tagValue', { tag: audience.tag });
      case 'plan': {
        const plan = plans.find((p) => p.id === audience.planId);
        return t('audience.planValue', {
          plan: plan ? (locale === 'en' && plan.nameEn ? plan.nameEn : plan.nameBg) : '—',
        });
      }
      case 'class':
        return t('audience.classValue', {
          title: classes.find((c) => c.id === audience.classId)?.title ?? '—',
        });
    }
  };
  // A message whose time has come is going out, whatever the sweep has done yet.
  const due =
    broadcast.status === 'sending' ||
    (broadcast.status === 'scheduled' &&
      new Date(broadcast.scheduledFor ?? 0).getTime() <= Date.now());
  const status = due
    ? t('status.sending')
    : broadcast.status === 'scheduled'
      ? t('status.scheduled', { when: formatDateTime(broadcast.scheduledFor ?? '', locale) })
      : broadcast.status === 'sent'
        ? t('status.sent', { when: formatDateTime(broadcast.finishedAt ?? '', locale) })
        : broadcast.cancelledBySystem
          ? t('status.cancelledStale')
          : t(`status.${broadcast.status}`);
  const smsPreview =
    broadcast.smsBody !== null
      ? composeSms({
          clubName: name,
          text: broadcast.smsBody,
          optOut:
            broadcast.purpose === 'marketing'
              ? // The real link's length: what the parts count must include.
                { label: t('smsOptOutLabel'), url: `${siteUrl()}/s/${'0'.repeat(32)}` }
              : null,
        })
      : null;
  const today = sofiaToday();
  const pillButton =
    'inline-flex min-h-9 items-center rounded-pill border border-line-strong px-4 text-body-sm font-semibold text-ink hover:bg-surface-2';

  return (
    <main className="space-y-6">
      <div>
        <Link
          href={`/klub/${slug}/saobshteniya`}
          className="text-body-sm font-semibold text-ink-soft underline-offset-2 hover:underline"
        >
          {t('back')}
        </Link>
        <h1 className="mt-2 text-h2 font-extrabold tracking-tight text-ink">{broadcast.subject}</h1>
        <p className="mt-1 text-body-sm text-ink-soft">
          {status}
          {' · '}
          {t(`purpose.${broadcast.purpose}`)}
          {' · '}
          {audienceLabel(broadcast.audience)}
        </p>
      </div>

      {rezultat && (
        <p
          role="status"
          className={
            t.has(`outcome.${rezultat}`)
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {t.has(`outcome.${rezultat}`)
            ? t(`outcome.${rezultat}`)
            : rezultat === 'readOnly'
              ? messages.readOnly
              : formErrorText(messages, rezultat)}
        </p>
      )}

      {reach && (
        <section className={section} aria-labelledby="reach-h">
          <h2 id="reach-h" className="text-h4 font-bold text-ink">
            {t('reach.title')}
          </h2>
          <ul className="space-y-1 text-body-sm text-ink">
            <li>{t('reach.recipients', { count: reach.recipients })}</li>
            {broadcast.channels.map((channel) => (
              <li key={channel}>{t(`reach.${channel}`, { count: reach[channel] })}</li>
            ))}
          </ul>
          <p className={small}>
            {t(broadcast.purpose === 'marketing' ? 'reach.hintMarketing' : 'reach.hint')}
          </p>
        </section>
      )}

      {broadcast.sent && (
        <section className={section} aria-labelledby="sent-h">
          <h2 id="sent-h" className="text-h4 font-bold text-ink">
            {t('sentTitle')}
          </h2>
          <p className="text-body-sm text-ink">
            {t('sentCounts', {
              email: broadcast.sent.email,
              sms: broadcast.sent.sms,
              push: broadcast.sent.push,
            })}
          </p>
        </section>
      )}

      <section className={section} aria-labelledby="text-h">
        <h2 id="text-h" className="text-h4 font-bold text-ink">
          {t('textTitle')}
        </h2>
        <p className="whitespace-pre-wrap text-body-sm text-ink">{broadcast.body}</p>
        {smsPreview && (
          <div className="rounded-card bg-surface-2 p-3">
            <p className="text-caption font-semibold text-ink-soft">
              {t('smsPreview', { parts: smsParts(smsPreview) })}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-body-sm text-ink">
              {smsPreview}
            </p>
          </div>
        )}
      </section>

      {broadcast.status === 'draft' && (
        <section className={section} aria-labelledby="send-h">
          <h2 id="send-h" className="text-h4 font-bold text-ink">
            {t('sendTitle')}
          </h2>
          <form action={scheduleBroadcastAction} className="space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="broadcastId" value={broadcast.id} />
            <fieldset className="space-y-2">
              <legend className="sr-only">{t('whenLabel')}</legend>
              <label className="flex min-h-11 items-center gap-3 text-body-sm text-ink">
                <input
                  type="radio"
                  name="when"
                  value="now"
                  defaultChecked
                  className="size-4 accent-[var(--brand)]"
                />
                {t('sendNow')}
              </label>
              <label className="flex min-h-11 flex-wrap items-center gap-3 text-body-sm text-ink">
                <input
                  type="radio"
                  name="when"
                  value="later"
                  className="size-4 accent-[var(--brand)]"
                />
                {t('sendLater')}
                <Input
                  type="date"
                  name="date"
                  size="sm"
                  min={today}
                  max={addDaysIso(today, 90)}
                  defaultValue={addDaysIso(today, 1)}
                  className="w-auto"
                  aria-label={t('date')}
                />
                <Input
                  type="time"
                  name="time"
                  size="sm"
                  defaultValue="10:00"
                  className="w-auto"
                  aria-label={t('time')}
                />
              </label>
            </fieldset>
            <ConfirmButton
              message={t('sendConfirm', { count: reach?.recipients ?? 0 })}
              className="inline-flex min-h-11 items-center rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand hover:bg-brand-hover"
            >
              {t('send')}
            </ConfirmButton>
          </form>
        </section>
      )}

      {(broadcast.status === 'scheduled' || broadcast.status === 'sending') && (
        <section className={section} aria-labelledby="change-h">
          <h2 id="change-h" className="text-h4 font-bold text-ink">
            {t('changeTitle')}
          </h2>
          <p className={small}>{t(due ? 'changeHintDue' : 'changeHint')}</p>
          <div className="flex flex-wrap gap-2">
            {!due && (
              <form action={unscheduleBroadcastAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="broadcastId" value={broadcast.id} />
                <Button type="submit" variant="secondary" size="sm">
                  {t('unschedule')}
                </Button>
              </form>
            )}
            <form action={cancelBroadcastAction}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="broadcastId" value={broadcast.id} />
              <ConfirmButton message={t('cancelConfirm')} className={pillButton}>
                {t('cancel')}
              </ConfirmButton>
            </form>
          </div>
        </section>
      )}

      {broadcast.status === 'draft' && (
        <section className={section} aria-labelledby="edit-h">
          <h2 id="edit-h" className="text-h4 font-bold text-ink">
            {t('editTitle')}
          </h2>
          <ComposeForm
            slug={slug}
            draft={broadcast}
            channels={channelsOn(club)}
            plans={plans
              .filter((plan) => !plan.archived)
              .map((plan) => ({
                id: plan.id,
                name: locale === 'en' && plan.nameEn ? plan.nameEn : plan.nameBg,
              }))}
            classes={classes
              .filter((klass) => klass.status === 'scheduled')
              .map((klass) => ({ id: klass.id, title: klass.title }))}
            tags={tags}
          />
          <form action={deleteBroadcastAction}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="broadcastId" value={broadcast.id} />
            <ConfirmButton message={t('deleteConfirm')} className={pillButton}>
              {t('delete')}
            </ConfirmButton>
          </form>
        </section>
      )}
    </main>
  );
}
