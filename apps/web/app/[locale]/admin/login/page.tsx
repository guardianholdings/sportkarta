import { getTranslations, setRequestLocale } from 'next-intl/server';

import { LoginForm } from './login-form';

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminLoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('AdminLogin');

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-4">
      <h1 className="mb-6 text-xl font-semibold">{t('title')}</h1>
      <LoginForm />
    </main>
  );
}
