import {
  INQUIRY_HORIZON_DAYS,
  INQUIRY_KINDS,
  INQUIRY_PARTY_MAX,
  THREAD_BODY_MAX,
  addDaysIso,
  sofiaToday,
} from '@sportkarta/lib/clubs';
import { Check } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ClubTrackingSlot } from '@/components/clubs/club-tracking-slot';
import { AppShell } from '@/components/shell/app-shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { inquiryTarget, memberOwnsThread } from '@/lib/clubs/inbox';
import { isUuid } from '@/lib/clubs/input';
import { signInHref } from '@/lib/sign-in-destination';
import { formErrorText, isOutcomeCode } from '@/lib/clubs/form-error';

import { inquiryAction } from './actions';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubInbox' });
  return { title: t('inquiry.title'), robots: { index: false, follow: true } };
}

/**
 * «Изпратете запитване» (0052, anolla's quote requests): a hall, an event,
 * a group, a party or a camp — what, perhaps when and for how many.
 * Signed in, so the club can answer, and the conversation continues in the
 * person's own portal at the club.
 */
export default async function InquiryPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string; razgovor?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  if (!clubsEnabled()) notFound();
  const club = await inquiryTarget(slug, locale);
  if (!club) notFound();
  const [t, messages, user] = await Promise.all([
    getTranslations('ClubInbox'),
    clubFormMessages(),
    getCurrentUser(),
  ]);
  const { rezultat, razgovor } = await searchParams;
  // Lead is reported to the club's pixels only for a conversation this
  // person just opened — never for an id pasted into the address.
  const leadId =
    rezultat === 'sent' && isUuid(razgovor) && user
      ? (await memberOwnsThread(user.id, club.id, razgovor))
        ? razgovor
        : null
      : null;
  const today = sofiaToday();
  const field = 'block text-body-sm font-semibold text-ink';
  const hint = 'mt-1 block text-caption font-normal text-text-muted';

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-5 p-4">
        <ClubTrackingSlot
          clubId={club.id}
          clubName={club.name}
          slug={slug}
          locale={locale}
          leadId={leadId}
          // The conversation's id is the club's and the member's, not the vendors'.
          hideParams={['razgovor']}
        />
        <header className="space-y-1 border-b border-line pb-3">
          <Link
            href={`/klub/${slug}`}
            className="text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {club.name}
          </Link>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('inquiry.title')}</h1>
          <p className="text-body-sm text-ink-soft">{t('inquiry.intro')}</p>
        </header>

        {rezultat === 'sent' ? (
          <section className="space-y-3 rounded-card border border-success-border bg-success-bg p-4">
            <p role="status" className="text-body text-ink">
              {t('inquiry.sent')}
            </p>
            {isUuid(razgovor) && (
              <Link
                href={`/klub/${slug}/az/saobshteniya/${razgovor}`}
                className={buttonVariants({ variant: 'secondary' })}
              >
                {t('inquiry.open')}
              </Link>
            )}
          </section>
        ) : (
          <>
            {rezultat && (
              <p
                role="status"
                className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
              >
                {isOutcomeCode(rezultat) && t.has(`inquiry.error.${rezultat}`)
                  ? t(`inquiry.error.${rezultat}`)
                  : rezultat === 'readOnly'
                    ? messages.readOnly
                    : formErrorText(messages, rezultat)}
              </p>
            )}
            {rezultat === 'claim_first' && (
              <Link href={`/klub/${slug}/az`} className={buttonVariants({ variant: 'secondary' })}>
                {t('inquiry.toPortal')}
              </Link>
            )}

            {!club.open ? (
              <p className="text-body-sm text-ink-soft">{t('inquiry.closed')}</p>
            ) : !user ? (
              <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
                <p className="text-body-sm text-ink">{t('inquiry.signInWhy')}</p>
                <Link
                  href={signInHref(`/klub/${slug}/zapitvane`)}
                  className={buttonVariants({ variant: 'primary' })}
                >
                  {t('inquiry.signIn')}
                </Link>
              </section>
            ) : (
              <form
                action={inquiryAction}
                className="space-y-4 rounded-card border border-line bg-surface p-4 shadow-sm"
              >
                <input type="hidden" name="slug" value={slug} />
                {/* Every choice in sight, one already made (UX audit: a select
                    with no default was a required tap before anything else).
                    «Друго» is the honest default — a wrong guess would file
                    the inquiry under the wrong kind in the club's inbox. */}
                <fieldset className={field}>
                  <legend>{t('inquiry.kind')}</legend>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {INQUIRY_KINDS.map((kind) => (
                      <label
                        key={kind}
                        className="group inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink-soft has-[:checked]:border-brand has-[:checked]:bg-brand-subtle has-[:checked]:text-brand has-[:focus-visible]:shadow-[var(--ring)]"
                      >
                        {/* The choice is shown by a mark, not by colour alone. */}
                        <Check
                          size={16}
                          aria-hidden="true"
                          className="hidden group-has-[:checked]:block"
                        />
                        <input
                          type="radio"
                          name="kind"
                          value={kind}
                          defaultChecked={kind === 'other'}
                          required
                          className="sr-only"
                        />
                        {t(`kinds.${kind}`)}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className={field}>
                    {t('inquiry.on')}
                    <Input
                      name="on"
                      type="date"
                      min={today}
                      max={addDaysIso(today, INQUIRY_HORIZON_DAYS)}
                      className="mt-1"
                    />
                    <span className={hint}>{t('inquiry.optional')}</span>
                  </label>
                  <label className={field}>
                    {t('inquiry.party')}
                    <Input
                      name="partySize"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={INQUIRY_PARTY_MAX}
                      className="mt-1"
                    />
                    <span className={hint}>{t('inquiry.optional')}</span>
                  </label>
                </div>
                <label className={field}>
                  {t('inquiry.message')}
                  <Textarea
                    name="body"
                    required
                    maxLength={THREAD_BODY_MAX}
                    rows={6}
                    className="mt-1"
                  />
                  <span className={hint}>{t('inquiry.messageHint')}</span>
                </label>
                <p className="text-caption text-text-muted">{t('inquiry.privacy')}</p>
                <Button type="submit">{t('inquiry.send')}</Button>
              </form>
            )}
          </>
        )}
      </main>
    </AppShell>
  );
}
