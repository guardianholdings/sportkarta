import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { unsubscribeTarget } from '@/lib/clubs/unsubscribe';

import { unsubscribeAction } from './actions';

/**
 * Opt out of a club's mail through POPS, for a client without an account.
 * No sign-in, no personal data on the page — the club's name and a button.
 * A GET never changes anything (link scanners prefetch mail links); the
 * button posts.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; token: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubUnsubscribe' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

export default async function ClubUnsubscribePage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ gotovo?: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const t = await getTranslations('ClubUnsubscribe');
  const target = await unsubscribeTarget(token, locale);
  const { gotovo } = await searchParams;

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      {!target ? (
        <p className="text-body text-ink-soft">{t('invalid')}</p>
      ) : target.optedOut || gotovo === '1' ? (
        <p
          role="status"
          className="rounded-card border border-success-border bg-success-bg p-3 text-body text-ink"
        >
          {t('done', { club: target.clubName })}
        </p>
      ) : (
        <>
          <p className="text-body text-ink">{t('body', { club: target.clubName })}</p>
          <form action={unsubscribeAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit">{t('confirm')}</Button>
          </form>
        </>
      )}
    </main>
  );
}
