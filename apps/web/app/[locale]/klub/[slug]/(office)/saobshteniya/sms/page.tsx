import { SMS_NOTIFY_KINDS, clubHasFeature, lowestTierWith } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubSwitchOn, featureOn } from '@/lib/clubs/features';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { smsOverview } from '@/lib/clubs/messages';
import { formErrorText, isOutcomeCode } from '@/lib/clubs/form-error';

import { saveSmsSettingsAction } from '../actions';
import { MessagesTabs } from '../parts';

export const dynamic = 'force-dynamic';

/**
 * The club's SMS (0051): how much of this month's allowance is used (the
 * operator sets it — SMS cost money per part, re-invoiced to the club), and
 * which automatic notices also go by SMS.
 */
export default async function ClubSmsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'settings.manage');
  const [t, tClub, messages] = await Promise.all([
    getTranslations('ClubMessages'),
    getTranslations('Club'),
    clubFormMessages(),
  ]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';

  if (!clubHasFeature(club.tier, 'sms')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('sms.title')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {t('sms.upsell', { tier: tClub(`tier.${lowestTierWith('sms')}`) })}
        </p>
      </main>
    );
  }

  const overview = await smsOverview(actor);
  const on = clubSwitchOn('sms');

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('sms.title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('sms.intro')}</p>
      </div>

      <MessagesTabs
        slug={slug}
        current="sms"
        show={{ auto: featureOn(club, 'automations'), sms: true }}
      />

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

      {!on && <p className="text-body-sm text-ink-soft">{t('sms.notRunning')}</p>}

      {overview && (
        <section className={section} aria-labelledby="usage-h">
          <h2 id="usage-h" className="text-h4 font-bold text-ink">
            {t('sms.usageTitle')}
          </h2>
          <p className="text-body-sm text-ink">
            {overview.cap === 0
              ? t('sms.noAllowance')
              : t('sms.usage', { used: overview.usedThisMonth, cap: overview.cap })}
          </p>
          <p className="text-caption text-text-muted">{t('sms.partsHint')}</p>
        </section>
      )}

      {overview && (
        <section className={section} aria-labelledby="notify-h">
          <h2 id="notify-h" className="text-h4 font-bold text-ink">
            {t('sms.notifyTitle')}
          </h2>
          <form action={saveSmsSettingsAction} className="space-y-2">
            <input type="hidden" name="slug" value={slug} />
            {SMS_NOTIFY_KINDS.map((kind) => (
              <label key={kind} className="flex min-h-11 items-center gap-3 text-body-sm text-ink">
                <input
                  type="checkbox"
                  name="smsNotify"
                  value={kind}
                  defaultChecked={overview.notify.includes(kind)}
                  className="size-4 accent-[var(--brand)]"
                />
                {t(`sms.notify.${kind}`)}
              </label>
            ))}
            <Button type="submit" size="sm">
              {t('sms.save')}
            </Button>
          </form>
        </section>
      )}
    </main>
  );
}
