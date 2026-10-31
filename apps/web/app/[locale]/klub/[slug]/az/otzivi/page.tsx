import { FEEDBACK_COMMENT_MAX, FEEDBACK_WINDOW_DAYS } from '@sportkarta/lib/clubs';
import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { feedbackToGive, googleReviewUrlOf } from '@/lib/clubs/feedback';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { portalView } from '@/lib/clubs/portal';
import { formatDateTime } from '@/lib/format';
import { formErrorText, isOutcomeCode } from '@/lib/clubs/form-error';

import { rateAction } from './actions';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubFeedback' });
  return { title: t('portal.title'), robots: { index: false, follow: false } };
}

/**
 * «Оценете» (0052): the member's own classes and bookings of the last two
 * weeks, each rated once — 1 to 5 stars and an optional comment that only
 * the club reads. After a good rating, the club's own Google review link.
 */
export default async function PortalFeedbackPage({
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
  const { rezultat } = await searchParams;
  const [t, messages, due, google] = await Promise.all([
    getTranslations('ClubFeedback'),
    clubFormMessages(),
    feedbackToGive(user.id, view.club.id, locale),
    rezultat === 'rated_google' ? googleReviewUrlOf(view.club.id) : Promise.resolve(null),
  ]);
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const thanks = rezultat === 'rated' || rezultat === 'rated_google';

  return (
    <AppShell active="/profil">
      <main className="mx-auto max-w-2xl space-y-5 p-4">
        <header className="space-y-1 border-b border-line pb-3">
          <Link
            href={`/klub/${slug}/az`}
            className="text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {view.club.name}
          </Link>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('portal.title')}</h1>
          <p className="text-body-sm text-ink-soft">
            {t('portal.intro', { days: FEEDBACK_WINDOW_DAYS })}
          </p>
        </header>

        {rezultat && (
          <div
            role="status"
            className={
              thanks
                ? 'space-y-2 rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
                : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
            }
          >
            <p>
              {thanks
                ? t('portal.thanks')
                : isOutcomeCode(rezultat) && t.has(`portal.error.${rezultat}`)
                  ? t(`portal.error.${rezultat}`)
                  : rezultat === 'readOnly'
                    ? messages.readOnly
                    : formErrorText(messages, rezultat)}
            </p>
            {google && (
              <p>
                <a
                  href={google}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-link"
                >
                  {t('portal.google')}
                  <ExternalLink aria-hidden="true" className="size-4" />
                </a>
              </p>
            )}
          </div>
        )}

        {due.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('portal.nothing')}</p>
        ) : (
          due.map((item) => (
            <section
              key={`${item.kind}-${item.id}`}
              className={section}
              aria-labelledby={`fb-${item.id}`}
            >
              <h2 id={`fb-${item.id}`} className="text-h4 font-bold text-ink">
                {item.title}
              </h2>
              <p className="text-caption text-text-muted">
                {formatDateTime(item.startsAt, locale)}
              </p>
              <form action={rateAction} className="space-y-3">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="kind" value={item.kind} />
                <input type="hidden" name="id" value={item.id} />
                <fieldset>
                  <legend className="text-body-sm font-semibold text-ink">
                    {t('portal.ratingLabel')}
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <label
                        key={n}
                        className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
                      >
                        <input
                          type="radio"
                          name="rating"
                          value={n}
                          required
                          className="size-4 accent-[var(--brand)]"
                        />
                        <span aria-hidden="true">{'★'.repeat(n)}</span>
                        <span className="sr-only">{t('stars', { count: n })}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="block text-body-sm font-semibold text-ink">
                  {t('portal.commentLabel')}
                  <Textarea
                    name="comment"
                    maxLength={FEEDBACK_COMMENT_MAX}
                    rows={3}
                    size="sm"
                    className="mt-1"
                  />
                  <span className="mt-1 block text-caption font-normal text-text-muted">
                    {t('portal.commentHint')}
                  </span>
                </label>
                <Button type="submit">{t('portal.send')}</Button>
              </form>
            </section>
          ))
        )}
      </main>
    </AppShell>
  );
}
