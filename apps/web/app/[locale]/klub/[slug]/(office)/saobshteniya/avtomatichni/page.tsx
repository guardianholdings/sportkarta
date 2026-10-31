import {
  AUTOMATION_TRIGGERS,
  BROADCAST_BODY_MAX,
  BROADCAST_SUBJECT_MAX,
  SMS_BODY_MAX,
  automationChannels,
  automationDefaultDelay,
  automationMaxDelay,
  automationMinDelay,
  automationPurpose,
  clubHasFeature,
  lowestTierWith,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { SmsTextarea } from '@/components/clubs/sms-textarea';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { channelsOn, listAutomations } from '@/lib/clubs/messages';
import { formErrorText, isOutcomeCode } from '@/lib/clubs/form-error';

import { saveAutomationAction } from '../actions';
import { MessagesTabs } from '../parts';

export const dynamic = 'force-dynamic';

/**
 * Messages that go by themselves (0051): a welcome after the first visit,
 * follow-ups after a trial or an abonnement that ended, a "we miss you"
 * after a gap, and (0052, where the tier has ratings) a request to rate a
 * class the member came to. Each runs daily at 10:15 and answers each event
 * once; the follow-ups and the "we miss you" are offers, so they reach only
 * members who agreed to offers.
 */
export default async function ClubAutomationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'messages.send');
  const [t, tClub, messages] = await Promise.all([
    getTranslations('ClubMessages'),
    getTranslations('Club'),
    clubFormMessages(),
  ]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const hint = 'mt-1 block text-caption font-normal text-text-muted';

  if (!clubHasFeature(club.tier, 'automations')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('auto.title')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {t('upsell', { tier: tClub(`tier.${lowestTierWith('automations')}`) })}
        </p>
      </main>
    );
  }

  const automations = await listAutomations(actor);
  const channels = channelsOn(club).filter((c) => c !== 'push');

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('auto.title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('auto.intro')}</p>
      </div>

      <MessagesTabs slug={slug} current="auto" show={{ auto: true, sms: featureOn(club, 'sms') }} />

      {rezultat && (
        <p
          role="status"
          className={
            isOutcomeCode(rezultat) && t.has(`outcome.${rezultat}`)
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {isOutcomeCode(rezultat) && t.has(`outcome.${rezultat}`)
            ? t(`outcome.${rezultat}`)
            : rezultat === 'readOnly'
              ? messages.readOnly
              : formErrorText(messages, rezultat)}
        </p>
      )}

      {AUTOMATION_TRIGGERS.filter(
        (trigger) => trigger !== 'feedback_request' || featureOn(club, 'feedback'),
      ).map((trigger) => (
        <section key={trigger} className={section} aria-labelledby={`au-${trigger}`}>
          <div>
            <h2 id={`au-${trigger}`} className="text-h4 font-bold text-ink">
              {t(`auto.trigger.${trigger}.title`)}
            </h2>
            <p className="text-caption text-ink-soft">
              {t(`auto.trigger.${trigger}.hint`)}
              {' · '}
              {t(automationPurpose(trigger) === 'service' ? 'auto.service' : 'auto.marketing')}
            </p>
          </div>
          {channels
            .filter((channel) => automationChannels(trigger).includes(channel))
            .map((channel) => {
              const current = automations.find(
                (a) => a.trigger === trigger && a.channel === channel,
              );
              const set = current?.id !== null && current?.id !== undefined;
              return (
                <details key={channel} className="rounded-card border border-line p-3" open={set}>
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-body-sm font-semibold text-ink">
                    <span>{t(`channels.${channel}`)}</span>
                    <span className="text-caption font-semibold text-ink-soft">
                      {set ? t(current?.active ? 'auto.on' : 'auto.off') : t('auto.notSet')}
                    </span>
                  </summary>
                  <form action={saveAutomationAction} className="mt-3 space-y-3">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="trigger" value={trigger} />
                    <input type="hidden" name="channel" value={channel} />
                    <label className={field}>
                      {t('auto.delay')}
                      <Input
                        name="delayDays"
                        type="number"
                        inputMode="numeric"
                        required
                        min={automationMinDelay(trigger)}
                        max={automationMaxDelay(trigger)}
                        defaultValue={current?.delayDays ?? automationDefaultDelay(trigger)}
                        size="sm"
                        className="mt-1 w-28"
                      />
                      <span className={hint}>{t(`auto.trigger.${trigger}.delayHint`)}</span>
                    </label>
                    {channel === 'email' ? (
                      <>
                        <label className={field}>
                          {t('subject')}
                          <Input
                            name="subject"
                            required
                            maxLength={BROADCAST_SUBJECT_MAX}
                            defaultValue={current?.subject ?? ''}
                            size="sm"
                            className="mt-1"
                          />
                        </label>
                        <label className={field}>
                          {t('body')}
                          <Textarea
                            name="body"
                            required
                            maxLength={BROADCAST_BODY_MAX}
                            rows={6}
                            size="sm"
                            defaultValue={current?.body ?? ''}
                            className="mt-1"
                          />
                          <span className={hint}>{t('placeholders')}</span>
                        </label>
                      </>
                    ) : (
                      <label className={field}>
                        {t('smsBody')}
                        <SmsTextarea
                          name="body"
                          required
                          maxLength={SMS_BODY_MAX}
                          defaultValue={current?.body ?? ''}
                          counter={t.raw('smsCounter') as string}
                        />
                        <span className={hint}>{t('placeholders')}</span>
                      </label>
                    )}
                    <label className="flex min-h-11 items-center gap-3 text-body-sm text-ink">
                      <input
                        type="checkbox"
                        name="active"
                        defaultChecked={set ? current?.active : true}
                        className="size-4 accent-[var(--brand)]"
                      />
                      {t('auto.active')}
                    </label>
                    <Button type="submit" size="sm">
                      {t('auto.save')}
                    </Button>
                  </form>
                </details>
              );
            })}
        </section>
      ))}
    </main>
  );
}
