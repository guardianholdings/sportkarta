import { getDb } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { subscriptionByToken } from '@/lib/digest';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';

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
 *
 * Both screens NAME THE CITY (L-6): a member subscribed to two cities could
 * not tell which one this link stopped. The GET reads it — a read, never the
 * delete — and the done screen gets the municipality id from the action.
 */

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; token: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Digest' });
  // A real title (D-4): this used to set only robots, so the tab read as the
  // bare site title.
  return { title: t('unsubscribeConfirmTitle'), robots: { index: false, follow: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The done screen's city, from the id the action passed along — or null. */
async function cityName(rawId: string | undefined, locale: string): Promise<string | null> {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const city = (await loadCityCatalog()).byId.get(id);
  return city ? cityDisplayName(city.nameBg, city.nameEn, locale) : null;
}

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Digest');
  const query = await searchParams;
  const done = first(query.done);

  if (done) {
    const city = done === 'ok' ? await cityName(first(query.m), locale) : null;
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">
          {done !== 'ok'
            ? t('unsubscribeInvalid')
            : city
              ? t('unsubscribedCity', { city })
              : t('unsubscribed')}
        </h1>
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('backToMap')}
        </Link>
      </main>
    );
  }

  const subscription = await subscriptionByToken(getDb(), token);

  // An unknown or already-used token: say so now, rather than offer a button
  // whose only possible answer is the same sentence.
  if (!subscription) {
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">
          {t('unsubscribeInvalid')}
        </h1>
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('backToMap')}
        </Link>
      </main>
    );
  }

  const city = cityDisplayName(subscription.nameBg, subscription.nameEn, locale);

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">
        {t('unsubscribeConfirmTitleCity', { city })}
      </h1>
      <p className="text-ink-soft">{t('unsubscribeConfirmBody')}</p>
      <form action={confirmUnsubscribeAction}>
        <input type="hidden" name="token" value={token} />
        {/* The action has no request path of its own to redirect against. */}
        <input type="hidden" name="locale" value={locale} />
        {/* The Button primitive, not a hand-rolled twin: the bare `shadow-xs`
            version silently discarded the global focus ring (see button.tsx). */}
        <Button type="submit">{t('optOut')}</Button>
      </form>
      <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
        {t('backToMap')}
      </Link>
    </main>
  );
}
