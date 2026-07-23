import { getTranslations } from 'next-intl/server';

import { calendarTokenAction } from '@/app/[locale]/profil/actions';

/**
 * The private calendar-feed panel (docs/ROADMAP.md §6, Stage 4.2).
 *
 * Plain forms, no client component: two buttons and a URL to copy, and it must
 * work before hydration.
 *
 * The URL IS the credential — a calendar client cannot sign in, so anyone
 * holding this link can read where this member plays. The panel says that in
 * as many words rather than presenting it as an ordinary share link, and it
 * offers rotation right next to it, because rotation is the only recovery once
 * a feed URL has been pasted into a shared calendar.
 *
 * The token is minted on request, never on sign-up: a credential nobody asked
 * for should not exist.
 */
export async function CalendarPanel({ token, siteUrl }: { token: string | null; siteUrl: string }) {
  const t = await getTranslations('Session');
  const feedUrl = token ? `${siteUrl.replace(/\/+$/, '')}/kalendar/${token}.ics` : null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t('feedHeading')}</h2>
      <p className="text-sm text-neutral-700">{t('feedIntro')}</p>

      {feedUrl ? (
        <>
          {/* Selectable text rather than a link: clicking it would open the
              download, and what the member needs is to copy it into a calendar
              app's "subscribe by URL" box. */}
          <p className="overflow-x-auto rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-xs">
            {feedUrl}
          </p>
          <p className="text-sm text-amber-800">{t('feedSecretWarning')}</p>
          <form action={calendarTokenAction}>
            <input type="hidden" name="rotate" value="true" />
            <button type="submit" className="rounded border border-neutral-300 px-3 py-1.5 text-sm">
              {t('feedRotate')}
            </button>
          </form>
          <p className="text-xs text-neutral-500">{t('feedRotateHint')}</p>
        </>
      ) : (
        <form action={calendarTokenAction}>
          <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
            {t('feedCreate')}
          </button>
        </form>
      )}
    </section>
  );
}
