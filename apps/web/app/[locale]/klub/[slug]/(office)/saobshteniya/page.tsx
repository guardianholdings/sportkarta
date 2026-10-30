import {
  BROADCAST_HOURS,
  BROADCASTS_PER_DAY,
  clubHasFeature,
  lowestTierWith,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { clubName, requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import {
  channelsOn,
  clubTagsInUse,
  listBroadcasts,
  type ClubBroadcast,
} from '@/lib/clubs/messages';
import { listPlans } from '@/lib/clubs/sales';
import { listClasses } from '@/lib/clubs/schedule';
import { formatDateTime } from '@/lib/format';
import { formErrorText } from '@/lib/clubs/form-error';

import { ComposeForm, MessagesTabs } from './parts';

export const dynamic = 'force-dynamic';

/**
 * «Съобщения» (0051, wave F): a message from the club to a group of its
 * clients — by e-mail, SMS or a notification on the phone. A new message is
 * saved as a draft first; its page shows how many it will reach and sends
 * it, now or at a set time.
 */
export default async function ClubMessagesPage({
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

  if (!clubHasFeature(club.tier, 'broadcasts')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {t('upsell', { tier: tClub(`tier.${lowestTierWith('broadcasts')}`) })}
        </p>
      </main>
    );
  }

  const [broadcasts, plans, classes, tags] = await Promise.all([
    listBroadcasts(actor),
    listPlans(actor),
    listClasses(actor),
    clubTagsInUse(actor),
  ]);
  const status = (b: ClubBroadcast) => {
    switch (b.status) {
      case 'scheduled':
        return new Date(b.scheduledFor ?? 0).getTime() <= Date.now()
          ? t('status.sending')
          : t('status.scheduled', { when: formatDateTime(b.scheduledFor ?? '', locale) });
      case 'sent':
        return t('status.sent', { when: formatDateTime(b.finishedAt ?? '', locale) });
      case 'cancelled':
        return t(b.cancelledBySystem ? 'status.cancelledStale' : 'status.cancelled');
      default:
        return t(`status.${b.status}`);
    }
  };

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">
          {t('intro', { club: clubName(club, locale) })}
        </p>
      </div>

      <MessagesTabs
        slug={slug}
        current="list"
        show={{ auto: featureOn(club, 'automations'), sms: featureOn(club, 'sms') }}
      />

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

      <section className={section} aria-labelledby="list-h">
        <h2 id="list-h" className="text-h4 font-bold text-ink">
          {t('listTitle')}
        </h2>
        {broadcasts.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {broadcasts.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 flex-1 text-body-sm">
                  <Link
                    href={`/klub/${slug}/saobshteniya/${b.id}`}
                    className="font-semibold text-ink underline-offset-2 hover:underline"
                  >
                    {b.subject}
                  </Link>
                  <span className="block text-caption text-text-muted">
                    {t(`purpose.${b.purpose}`)}
                    {' · '}
                    {b.channels.map((channel) => t(`channels.${channel}`)).join(', ')}
                    {b.sent
                      ? ` · ${t('sentCounts', { email: b.sent.email, sms: b.sent.sms, push: b.sent.push })}`
                      : ''}
                  </span>
                </span>
                <span className="text-caption font-semibold text-ink-soft">{status(b)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={section} aria-labelledby="new-h">
        <h2 id="new-h" className="text-h4 font-bold text-ink">
          {t('newTitle')}
        </h2>
        <p className="text-caption text-text-muted">
          {t('newHint', {
            count: BROADCASTS_PER_DAY,
            from: String(BROADCAST_HOURS.from).padStart(2, '0'),
            until: String(BROADCAST_HOURS.until).padStart(2, '0'),
          })}
        </p>
        <ComposeForm
          slug={slug}
          draft={null}
          channels={channelsOn(club)}
          plans={plans.map((plan) => ({
            id: plan.id,
            name: locale === 'en' && plan.nameEn ? plan.nameEn : plan.nameBg,
          }))}
          classes={classes
            .filter((klass) => klass.status === 'scheduled')
            .map((klass) => ({ id: klass.id, title: klass.title }))}
          tags={tags}
        />
      </section>
    </main>
  );
}
