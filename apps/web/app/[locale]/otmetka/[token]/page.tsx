import { verifyCheckinToken } from '@sportkarta/lib/checkin-token';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { checkinSecret } from '@/lib/checkin-config';
import { occurrenceView } from '@/lib/sessions/occurrence';

import { CheckinForm } from './checkin-form';

/**
 * Where a scanned check-in QR lands (docs/ROADMAP.md §7, Stage 5.4).
 *
 * The token is verified HERE as well as in the action. Not defence in depth for
 * its own sake: without it, somebody scanning an expired code would be shown a
 * cheerful "check in" button that fails after they press it, standing in a park
 * on a phone. Verifying up front lets the page say "this code has expired, ask
 * the organiser to show it again", which is the sentence they need.
 *
 * Signed out, the page explains itself and links to sign-in with `next` set, so
 * the scan is not simply lost — a QR is often somebody's first ever contact
 * with the site.
 *
 * noindex, and no locale alternates: this URL is valid for two minutes.
 */

export const dynamic = 'force-dynamic';

export const metadata = { robots: { index: false, follow: false } };

type PageParams = Promise<{ locale: string; token: string }>;

export default async function CheckinPage({ params }: { params: PageParams }) {
  const { locale, token } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('Checkin');
  const secret = checkinSecret();
  const verified = secret ? verifyCheckinToken(token, secret) : null;

  function Shell({ children }: { children: React.ReactNode }) {
    return <main className="mx-auto max-w-md space-y-4 p-4">{children}</main>;
  }

  if (!secret) {
    return (
      <Shell>
        <p role="alert">{t('disabled')}</p>
      </Shell>
    );
  }

  if (!verified?.ok) {
    // One message for every failure mode. A member cannot act on the difference
    // between "expired" and "forged", and spelling it out would hand an
    // attacker the oracle the verifier is careful not to be.
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t('invalidHeading')}</h1>
        <p className="text-neutral-700">{t('invalidBody')}</p>
      </Shell>
    );
  }

  const user = await getCurrentUser();
  const view = await occurrenceView(verified.occurrenceId, user?.id ?? null);
  if (!view) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t('invalidHeading')}</h1>
        <p className="text-neutral-700">{t('invalidBody')}</p>
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{view.title}</h1>
        <p className="text-neutral-700">{t('signInBody')}</p>
        {/* The token is carried through sign-in so the scan is not wasted —
            it may well have expired by the time they are back, which the page
            will then say plainly. */}
        <Link href={`/vhod?next=${encodeURIComponent(`/otmetka/${token}`)}`} className="underline">
          {t('signInLink')}
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{view.title}</h1>
        {view.facilityName && <p className="text-sm text-neutral-500">{view.facilityName}</p>}
      </header>

      <CheckinForm
        token={token}
        occurrenceId={verified.occurrenceId}
        labels={{
          submit: t('submit'),
          pending: t('pending'),
          locating: t('locating'),
          locationDenied: t('locationDenied'),
          locationHint: t('locationHint'),
          genericError: t('error.generic'),
          outcomes: {
            scored: t('outcome.scored'),
            unscored_method: t('outcome.unscored_method'),
            unscored_no_location: t('outcome.unscored_no_location'),
            unscored_out_of_range: t('outcome.unscored_out_of_range'),
            unscored_daily_cap: t('outcome.unscored_daily_cap'),
            unscored_already: t('outcome.unscored_already'),
          },
          errors: {
            rate_limited: t('error.rate_limited'),
            disabled: t('disabled'),
            invalid_checkin_token: t('error.invalid_checkin_token'),
            occurrence_cancelled: t('error.occurrence_cancelled'),
            occurrence_not_found: t('error.occurrence_not_found'),
            checkin_window_closed: t('error.checkin_window_closed'),
            not_organizer: t('error.not_organizer'),
          },
        }}
      />

      <p className="border-t border-neutral-200 pt-3 text-sm">
        <Link href={`/sesiya/${verified.occurrenceId}`} className="underline">
          {t('viewSession')}
        </Link>
      </p>
    </Shell>
  );
}
