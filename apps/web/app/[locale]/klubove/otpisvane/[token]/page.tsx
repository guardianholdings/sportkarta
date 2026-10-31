import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { unsubscribeScope, unsubscribeTarget } from '@/lib/clubs/unsubscribe';

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
  searchParams: Promise<{ gotovo?: string; vid?: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const t = await getTranslations('ClubUnsubscribe');
  const { gotovo, vid } = await searchParams;
  // What is being refused: all club mail, the club's offers, or SMS (0051).
  const scope = unsubscribeScope(vid);
  const target = await unsubscribeTarget(token, locale, scope);
  const say = (key: 'title' | 'done' | 'body' | 'confirm') =>
    scope === 'all' ? key : (`${scope}.${key}` as const);

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t(say('title'))}</h1>
      {!target ? (
        <p className="text-body text-ink-soft">{t('invalid')}</p>
      ) : target.optedOut || gotovo === '1' ? (
        <p
          role="status"
          className="rounded-card border border-success-border bg-success-bg p-3 text-body text-ink"
        >
          {t(say('done'), { club: target.clubName })}
        </p>
      ) : (
        <>
          <p className="text-body text-ink">{t(say('body'), { club: target.clubName })}</p>
          <form action={unsubscribeAction}>
            <input type="hidden" name="token" value={token} />
            {scope !== 'all' && <input type="hidden" name="vid" value={scope} />}
            <Button type="submit">{t(say('confirm'))}</Button>
          </form>
        </>
      )}
    </main>
  );
}
