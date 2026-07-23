import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import { confirmUnsubscribeAction } from './actions';

/**
 * Unsubscribe (docs/ROADMAP.md §6, Stage 4.4).
 *
 * Deliberately requires NO session: somebody who has lost interest must be able
 * to stop the mail without signing in, which is the difference between an
 * unsubscribe link that works and one that gets the sender marked as spam.
 * The token is random per subscription and cancels exactly one city.
 *
 * BUT THE GET DOES NOT UNSUBSCRIBE. It renders a confirm button that POSTs.
 * Corporate mail scanners — Microsoft Defender Safe Links, Proofpoint URL
 * Defense — fetch every URL in an inbound message to detonate it, so a
 * destructive GET would silently unsubscribe exactly the subscribers most
 * likely to be protected by one, before they had read the mail. It is also a
 * plain CSRF sink: an `<img src=…>` anywhere would cancel a subscription for
 * anyone whose token leaked into a log or a forwarded email.
 */

export const metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Digest');
  const done = (await searchParams).done;

  if (done) {
    return (
      <main className="mx-auto max-w-xl space-y-4 p-4">
        <h1 className="text-xl font-semibold">
          {done === 'ok' ? t('unsubscribed') : t('unsubscribeInvalid')}
        </h1>
        <Link href="/" className="text-sm underline">
          {t('backToMap')}
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t('unsubscribeConfirmTitle')}</h1>
      <p className="text-neutral-700">{t('unsubscribeConfirmBody')}</p>
      <form action={confirmUnsubscribeAction}>
        <input type="hidden" name="token" value={token} />
        {/* The action has no request path of its own to redirect against. */}
        <input type="hidden" name="locale" value={locale} />
        <button type="submit" className="rounded bg-neutral-900 px-4 py-3 font-medium text-white">
          {t('optOut')}
        </button>
      </form>
      <Link href="/" className="text-sm underline">
        {t('backToMap')}
      </Link>
    </main>
  );
}
