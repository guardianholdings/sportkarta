import {
  PUBLIC_RATING_MIN_COUNT,
  PUBLIC_RATING_MONTHS,
  clubHasFeature,
  lowestTierWith,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { feedbackOverview } from '@/lib/clubs/feedback';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { formatDate } from '@/lib/format';
import { formErrorText } from '@/lib/clubs/form-error';

import { saveGoogleReviewAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * «Отзиви» (0052, wave F2): how the club's clients rate what they came to —
 * the average and the spread, by class and by trainer, the latest comments
 * (the club's to read, never public), whether the public page shows the
 * average yet, and the club's own Google review link.
 */
export default async function ClubFeedbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'feedback.view');
  const [t, tClub, messages] = await Promise.all([
    getTranslations('ClubFeedback'),
    getTranslations('Club'),
    clubFormMessages(),
  ]);

  if (!clubHasFeature(club.tier, 'feedback')) {
    return (
      <main className="space-y-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="max-w-prose text-body-sm text-ink-soft">
          {t('upsell', { tier: tClub(`tier.${lowestTierWith('feedback')}`) })}
        </p>
      </main>
    );
  }

  const overview = await feedbackOverview(actor, locale);
  const { rezultat } = await searchParams;
  const good = rezultat !== undefined && t.has(`outcome.${rezultat}`);
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
  const decimal = (value: number) =>
    new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);

  return (
    <main className="space-y-5">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">
          {t('intro', { months: PUBLIC_RATING_MONTHS })}
        </p>
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

      {overview && (
        <>
          <section className={section} aria-labelledby="sum-h">
            <h2 id="sum-h" className="text-h4 font-bold text-ink">
              {t('summary')}
            </h2>
            {overview.count === 0 ? (
              <p className="text-body-sm text-text-muted">{t('none')}</p>
            ) : (
              <>
                <p className="text-body text-ink">
                  <span className="text-h3 font-extrabold">{decimal(overview.average ?? 0)}</span>{' '}
                  {t('outOf', { count: overview.count })}
                </p>
                <ul className="space-y-1 text-body-sm">
                  {[5, 4, 3, 2, 1].map((n) => (
                    <li key={n} className="flex items-center gap-3">
                      <span aria-hidden="true" className="w-24 text-ink-soft">
                        {stars(n)}
                      </span>
                      <span className="sr-only">{t('stars', { count: n })}</span>
                      <span className="text-ink">{overview.distribution[n - 1]}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="text-caption text-text-muted">
              {overview.publicShown
                ? t('publicShown')
                : t('publicHidden', {
                    count: PUBLIC_RATING_MIN_COUNT,
                    months: PUBLIC_RATING_MONTHS,
                  })}{' '}
              {t('publicBasis')}
            </p>
          </section>

          {(overview.byClass.length > 0 || overview.byTrainer.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {(
                [
                  ['byClass', overview.byClass],
                  ['byTrainer', overview.byTrainer],
                ] as const
              ).map(([key, groups]) =>
                groups.length === 0 ? null : (
                  <section key={key} className={section} aria-labelledby={`${key}-h`}>
                    <h2 id={`${key}-h`} className="text-h4 font-bold text-ink">
                      {t(key)}
                    </h2>
                    <ul className="divide-y divide-line">
                      {groups.map((group) => (
                        <li
                          key={group.id}
                          className="flex items-baseline justify-between gap-3 py-1.5 text-body-sm"
                        >
                          <span className="min-w-0 text-ink">{group.label || t('unknown')}</span>
                          <span className="text-ink-soft">
                            {decimal(group.average)} · {t('ratings', { count: group.count })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ),
              )}
            </div>
          )}

          <section className={section} aria-labelledby="recent-h">
            <h2 id="recent-h" className="text-h4 font-bold text-ink">
              {t('recent')}
            </h2>
            <p className="text-caption text-text-muted">{t('private')}</p>
            {overview.recent.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('none')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {overview.recent.map((item) => (
                  <li key={item.id} className="space-y-1 py-2">
                    <p className="flex flex-wrap items-baseline justify-between gap-2 text-body-sm">
                      <span className="text-ink">
                        <span aria-hidden="true">{stars(item.rating)}</span>
                        <span className="sr-only">{t('stars', { count: item.rating })}</span>
                        {' · '}
                        {item.subject}
                      </span>
                      <span className="text-caption text-text-muted">
                        {actorCan(actor, 'members.view') ? (
                          <Link
                            href={`/klub/${slug}/chlenove/${item.memberId}`}
                            className="text-link"
                          >
                            {item.memberName}
                          </Link>
                        ) : (
                          item.memberName
                        )}
                        {' · '}
                        {formatDate(item.createdAt, locale)}
                      </span>
                    </p>
                    {item.comment && (
                      <p className="whitespace-pre-wrap break-words text-body-sm text-ink-soft">
                        {item.comment}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {actorCan(actor, 'settings.manage') && (
            <section className={section} aria-labelledby="google-h">
              <h2 id="google-h" className="text-h4 font-bold text-ink">
                {t('googleTitle')}
              </h2>
              <p className="text-body-sm text-ink-soft">{t('googleHint')}</p>
              <form action={saveGoogleReviewAction} className="space-y-3">
                <input type="hidden" name="slug" value={slug} />
                <label className="block text-body-sm font-semibold text-ink">
                  {t('googleLabel')}
                  <Input
                    name="googleReviewUrl"
                    type="url"
                    inputMode="url"
                    maxLength={400}
                    defaultValue={overview.googleReviewUrl ?? ''}
                    placeholder={t('googlePlaceholder')}
                    size="sm"
                    className="mt-1"
                  />
                </label>
                <Button type="submit" size="sm">
                  {t('googleSave')}
                </Button>
              </form>
            </section>
          )}
        </>
      )}
    </main>
  );
}
