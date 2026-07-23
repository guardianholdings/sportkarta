import { calendarToken, getDb } from '@sportkarta/db';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { CalendarPanel } from '@/components/profile/calendar-panel';
import { DigestPanel } from '@/components/profile/digest-panel';
import { PointsPanel } from '@/components/profile/points-panel';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth-session';
import { digestCities, subscriptionsFor } from '@/lib/digest';
import { loadCityCatalog } from '@/lib/places';
import { pointsSummary } from '@/lib/points';
import { siteUrl } from '@/lib/seo';
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
  const [summary, digestOptions, subscriptions, catalog, feedToken] = await Promise.all([
    pointsSummary(getDb(), user.id),
    digestCities(getDb(), user.id),
    subscriptionsFor(getDb(), user.id),
    loadCityCatalog(),
    calendarToken(getDb(), user.id),
  ]);
  // digestCities knows which municipalities are worth offering; the catalog is
  // what turns them into the slugs /sedmitsata links use.
  const digestCityList = digestOptions
    .map((city) => catalog.byId.get(city.id))
    .filter((city): city is NonNullable<typeof city> => city !== undefined);
  const subscribedIds = new Set(subscriptions.map((s) => s.municipalityId));

  return (
    <main className="mx-auto max-w-xl space-y-10 p-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-200 pb-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
          <Link href="/pasport" className="underline">
            {t('passportLink')}
          </Link>
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

      <DigestPanel locale={locale} cities={digestCityList} subscribedIds={subscribedIds} />

      <CalendarPanel token={feedToken} siteUrl={siteUrl()} />

      <section className="space-y-4 rounded border border-red-200 p-4">
        <h2 className="text-lg font-semibold">{t('deleteTitle')}</h2>
        <DeleteAccountForm confirmationWord={t('deleteConfirmWord')} />
      </section>

      <p className="text-xs text-neutral-500">
        <Button asChild variant="ghost" className="h-auto p-0 text-xs">
          <Link href="/privacy">{t('privacyLink')}</Link>
        </Button>
      </p>
    </main>
  );
}
