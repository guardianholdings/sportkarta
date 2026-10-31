import { getTranslations } from 'next-intl/server';

import { calendarTokenAction } from '@/app/[locale]/profil/actions';
import { CopyUrl } from '@/components/profile/copy-url';

/**
 * The private calendar-feed panel (docs/ROADMAP.md §6, Stage 4.2).
 *
 * Plain forms for the two buttons, so they work before hydration; the URL sits
 * in a small client island (CopyUrl) only for its «Копирай».

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
  const [t, tShare] = await Promise.all([getTranslations('Session'), getTranslations('Share')]);
  const feedUrl = token ? `${siteUrl.replace(/\/+$/, '')}/kalendar/${token}.ics` : null;

  return (
    <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
      <h2 className="t-overline">{t('feedHeading')}</h2>
      <p className="text-body-sm text-ink-soft">{t('feedIntro')}</p>

      {feedUrl ? (
        <>
          <CopyUrl value={feedUrl} labels={{ copy: t('feedCopy'), copied: tShare('copied') }} />

          <p className="text-body-sm text-warning">{t('feedSecretWarning')}</p>
          <form action={calendarTokenAction}>
            <input type="hidden" name="rotate" value="true" />
            <button
              type="submit"
              className="rounded-pill border border-line-strong bg-surface px-3 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2"
            >
              {t('feedRotate')}
            </button>
          </form>
          <p className="text-caption text-text-muted">{t('feedRotateHint')}</p>
        </>
      ) : (
        <form action={calendarTokenAction}>
          <button
            type="submit"
            className="rounded-pill bg-brand px-3 py-1.5 text-caption font-semibold text-on-brand hover:bg-brand-hover"
          >
            {t('feedCreate')}
          </button>
        </form>
      )}
    </section>
  );
}
