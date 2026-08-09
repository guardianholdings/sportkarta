import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { resolveGoogleAuth } from '@/lib/auth-config';
import { getCurrentUser, PROFILE_PATH } from '@/lib/auth-session';
import { isAuthAvailable } from '@/lib/auth';

import { SignInForm } from './sign-in-form';
import { AppShell } from '@/components/shell/app-shell';

export const metadata = { robots: { index: false, follow: false } };

// Session-dependent and cookie-setting: never prerender.
export const dynamic = 'force-dynamic';

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('SignIn');

  if (await getCurrentUser()) redirect(PROFILE_PATH);

  const available = isAuthAvailable();
  const { next } = await searchParams;

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
        <header className="space-y-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-body-sm text-ink-soft">{t('intro')}</p>
        </header>
        {available ? (
          <SignInForm googleEnabled={resolveGoogleAuth(process.env).enabled} next={next ?? ''} />
        ) : (
          <p role="alert" className="text-body-sm text-danger">
            {t('error_auth_unavailable')}
          </p>
        )}
      </main>
    </AppShell>
  );
}
