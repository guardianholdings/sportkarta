import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { resolveGoogleAuth } from '@/lib/auth-config';
import { getCurrentUser, PROFILE_PATH } from '@/lib/auth-session';
import { isAuthAvailable } from '@/lib/auth';

import { SignInForm } from './sign-in-form';

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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-4">
      <h1 className="mb-2 text-xl font-semibold">{t('title')}</h1>
      <p className="mb-6 text-sm text-neutral-600">{t('intro')}</p>
      {available ? (
        <SignInForm googleEnabled={resolveGoogleAuth(process.env).enabled} next={next ?? ''} />
      ) : (
        <p role="alert" className="text-sm text-red-600">
          {t('error_auth_unavailable')}
        </p>
      )}
    </main>
  );
}
