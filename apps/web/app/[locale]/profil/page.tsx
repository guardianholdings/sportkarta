import { calendarToken, getDb } from '@sportkarta/db';
import { BookOpenCheck, ShieldCheck } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { CalendarPanel } from '@/components/profile/calendar-panel';
import { DigestPanel } from '@/components/profile/digest-panel';
import { PointsPanel } from '@/components/profile/points-panel';
import { AppShell } from '@/components/shell/app-shell';
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

const pillLink =
  'inline-flex items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2';

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
    <AppShell active="/profil">
      <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-5">
        <header>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="mt-1.5 text-body-sm text-ink-soft">{t('emailLine', { email: user.email })}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link href="/pasport" className={pillLink}>
              <BookOpenCheck size={15} />
              {t('passportLink')}
            </Link>
            {canAccessAdminPanel(user.role) && (
              <Link href="/admin" className={pillLink}>
                <ShieldCheck size={15} />
                {t('adminLink')}
              </Link>
            )}
            <form action={signOutAction} className="ml-auto">
              <Button type="submit" variant="ghost" size="sm">
                {t('signOut')}
              </Button>
            </form>
          </div>
        </header>

        <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <ProfileForm
            displayName={user.displayName}
            homeCity={user.homeCity ?? ''}
            isMinor={user.isMinor}
          />
        </section>

        <PointsPanel summary={summary} />

        <DigestPanel locale={locale} cities={digestCityList} subscribedIds={subscribedIds} />

        <CalendarPanel token={feedToken} siteUrl={siteUrl()} />

        <section className="space-y-4 rounded-card border border-danger-border bg-danger-bg/40 p-4">
          <h2 className="text-h4 font-bold text-danger">{t('deleteTitle')}</h2>
          <DeleteAccountForm confirmationWord={t('deleteConfirmWord')} />
        </section>

        <p className="text-caption text-text-muted">
          <Link href="/privacy" className="font-medium text-link hover:text-link-hover">
            {t('privacyLink')}
          </Link>
        </p>
      </main>
    </AppShell>
  );
}
