import { getDb } from '@sportkarta/db';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PointsPanel } from '@/components/profile/points-panel';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth-session';
import { pointsSummary } from '@/lib/points';
import { canAccessAdminPanel } from '@/lib/roles';
import { Link } from '@/i18n/navigation';

import { signOutAction } from '../vhod/actions';
import { DeleteAccountForm, ProfileForm } from './profile-form';

export const metadata = { robots: { index: false, follow: false } };

// Per-request: session cookie + live profile read.
export const dynamic = 'force-dynamic';

export default async function ProfilePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Profile');
  const user = await requireUser();
  const summary = await pointsSummary(getDb(), user.id);

  return (
    <main className="mx-auto max-w-xl space-y-10 p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-200 pb-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
          {canAccessAdminPanel(user.role) && (
            <Link href="/admin" className="underline">
              {t('adminLink')}
            </Link>
          )}
          <form action={signOutAction}>
            <button type="submit" className="underline">
              {t('signOut')}
            </button>
          </form>
        </div>
      </header>

      <section className="space-y-4">
        <p className="text-sm text-neutral-600">{t('emailLine', { email: user.email })}</p>
        <ProfileForm
          displayName={user.displayName}
          homeCity={user.homeCity ?? ''}
          isMinor={user.isMinor}
        />
      </section>

      <PointsPanel summary={summary} />

      <section className="space-y-4 rounded border border-red-200 p-4">
        <h2 className="text-lg font-semibold">{t('deleteTitle')}</h2>
        <DeleteAccountForm confirmationWord={t('deleteConfirmWord')} />
      </section>

      <p className="text-xs text-neutral-500">
        <Button asChild variant="link" className="h-auto p-0 text-xs">
          <Link href="/privacy">{t('privacyLink')}</Link>
        </Button>
      </p>
    </main>
  );
}
