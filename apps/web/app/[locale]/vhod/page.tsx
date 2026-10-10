import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { enabledSignInProviders } from '@/lib/auth-config';
import { getCurrentUser } from '@/lib/auth-session';
import { isAuthAvailable } from '@/lib/auth';
import { OTP_TTL_SECONDS } from '@/lib/auth-surface';
import { parseOAuthError } from '@/lib/oauth-error';
import { signInDestination, signInReason } from '@/lib/sign-in-destination';

import { SignInForm } from './sign-in-form';
import { AppShell } from '@/components/shell/app-shell';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'SignIn' });
  // Its own title: it used to inherit the site's, so the tab and the screen
  // reader's route announcement never said this was the sign-in page.
  return { title: t('title'), robots: { index: false, follow: false } };
}

// Session-dependent and cookie-setting: never prerender.
export const dynamic = 'force-dynamic';

type QueryValue = string | string[] | undefined;

function single(value: QueryValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    next?: QueryValue;
    error?: QueryValue;
    provider?: QueryValue;
    deleted?: QueryValue;
  }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('SignIn');

  const { next, error, provider, deleted } = await searchParams;
  const reason = signInReason(single(next));
  // Already signed in: go where the link was headed (a shared session, a QR
  // scan), in this page's language — not to the profile, and not in Bulgarian.
  if (await getCurrentUser()) return redirect({ href: signInDestination(next), locale });

  const available = isAuthAvailable();

  return (
    <AppShell active="/profil">
      {/*
        `min-h-screen` + `justify-center` used to live here, INSIDE AppShell's own
        `min-h-dvh` shell and above its 56px tab bar — so the page was one
        viewport plus a tab bar tall, always scrolled, and the form sat pushed
        into the lower half under roughly 490px of empty paper at 390x844. It is
        top-aligned with generous breathing room instead: the field a visitor
        came here to fill is the first thing on the screen.

        (`max-w-sm` also silently rendered at 640px until the --container-*
        collision was resolved in design-tokens/spacing.css; it is 384px now,
        which is the width this line always meant.)
      */}
      <main className="mx-auto w-full max-w-sm space-y-6 px-4 pt-10 pb-8 sm:pt-16">
        {/* After «Изтрий профила ми» the member used to land on the map with
            no word that anything had happened. */}
        {deleted === '1' && (
          <p
            role="status"
            className="rounded-card bg-success-bg px-4 py-3 text-body-sm text-success"
          >
            {t('deleted')}
          </p>
        )}
        <header className="space-y-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          {/* Why they are here, when a page sent them: «+» used to land on a
              bare «Вход в POPS». */}
          {reason && <p className="text-body font-semibold text-ink">{t(`reason.${reason}`)}</p>}
          <p className="text-body-sm text-ink-soft">{t('intro')}</p>
        </header>
        {available ? (
          <SignInForm
            providers={enabledSignInProviders(process.env)}
            codeMinutes={OTP_TTL_SECONDS / 60}
            oauthError={parseOAuthError(single(error), single(provider))}
            next={single(next) ?? ''}
          />
        ) : (
          <p role="alert" className="text-body-sm text-danger">
            {t('error_auth_unavailable')}
          </p>
        )}
      </main>
    </AppShell>
  );
}
