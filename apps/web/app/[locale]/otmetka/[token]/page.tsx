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
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('invalidHeading')}</h1>
        <p className="text-ink-soft">{t('invalidBody')}</p>
      </Shell>
    );
  }

  const user = await getCurrentUser();
  const view = await occurrenceView(verified.occurrenceId, user?.id ?? null);
  if (!view) {
    return (
      <Shell>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('invalidHeading')}</h1>
        <p className="text-ink-soft">{t('invalidBody')}</p>
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{view.title}</h1>
        <p className="text-ink-soft">{t('signInBody')}</p>
        {/* The token is carried through sign-in so the scan is not wasted —
            it may well have expired by the time they are back, which the page
            will then say plainly. */}
        <Link
          href={`/vhod?next=${encodeURIComponent(`/otmetka/${token}`)}`}
          className="font-medium text-link hover:text-link-hover"
        >
          {t('signInLink')}
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="space-y-1">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{view.title}</h1>
        {view.facilityName && <p className="text-body-sm text-text-muted">{view.facilityName}</p>}
      </header>

      {/* CheckinForm resolves its own copy: the success line names the points
          earned, which is only known after the action returns, so it cannot be
          pre-resolved here. See the component's header. */}
      <CheckinForm token={token} occurrenceId={verified.occurrenceId} />

      <p className="border-t border-line pt-3 text-body-sm">
        <Link
          href={`/sesiya/${verified.occurrenceId}`}
          className="font-medium text-link hover:text-link-hover"
        >
          {t('viewSession')}
        </Link>
      </p>
    </Shell>
  );
}
