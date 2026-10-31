import type { Metadata } from 'next';
import { calendarToken, getDb } from '@sportkarta/db';
import { Activity, Building2, Download, LogOut, ShieldCheck } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { CalendarPanel } from '@/components/profile/calendar-panel';
import { DigestPanel } from '@/components/profile/digest-panel';
import { AppShell } from '@/components/shell/app-shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { PushToggle } from '@/components/pwa/push-toggle';
import { requireUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { digestCities, subscriptionsFor } from '@/lib/digest';
import { loadCityCatalog } from '@/lib/places';
import { pushDeviceCount, pushPublicKey, pushToggleLabels } from '@/lib/push';
import { siteUrl } from '@/lib/seo';
import { canAccessAdminPanel } from '@/lib/roles';
import { Link } from '@/i18n/navigation';

import { signOutAction } from '../vhod/actions';
import { DeleteAccountForm, ProfileForm } from './profile-form';
import { removeAllDevicesAction } from './push-actions';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Profile' });
  // A title of its own (UX audit 2026-10-10): it inherited the site's, so
  // moving between /profil, /pasport and /vhod announced nothing at all.
  return { title: t('title'), robots: { index: false, follow: false } };
}

// Per-request: session cookie + live profile read.
export const dynamic = 'force-dynamic';

const pillLink =
  'inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-4 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2';

export default async function ProfilePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Profile');
  const user = await requireUser();
  // Notifications on this device (0051): offered only while POPS runs push.
  const pushKey = clubsEnabled() ? pushPublicKey() : null;
  const [digestOptions, subscriptions, catalog, feedToken, tPush, pushLabels, devices] =
    await Promise.all([
      digestCities(getDb(), user.id),
      subscriptionsFor(getDb(), user.id),
      loadCityCatalog(),
      calendarToken(getDb(), user.id),
      getTranslations('PushDevice'),
      pushToggleLabels(),
      pushKey ? pushDeviceCount(user.id) : Promise.resolve(0),
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
          <p className="mt-1.5 text-body-sm text-ink-soft">
            {t('emailLine', { email: user.email })}
          </p>
          {/*
            SETTINGS, not a second hub (UX audit N8): the passport is a tab and
            carries the points, so its pill and the «Моите точки» panel are gone.
            What stays here is what has no tab — the log (also a segment of
            Тренировки), the clubs, the admin.
          */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link href="/trenirovki" className={pillLink}>
              <Activity size={15} />
              {t('trainingLink')}
            </Link>
            {/* The club hub (Stage 9) lives here for the same reason: no fifth tab. */}
            {clubsEnabled() && (
              <Link href="/klub" className={pillLink}>
                <Building2 size={15} />
                {t('clubsLink')}
              </Link>
            )}
            {canAccessAdminPanel(user.role) && (
              <Link href="/admin" className={pillLink}>
                <ShieldCheck size={15} />
                {t('adminLink')}
              </Link>
            )}
          </div>
        </header>

        <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <ProfileForm
            displayName={user.displayName}
            homeCity={user.homeCity ?? ''}
            isMinor={user.isMinor}
          />
        </section>

        {/* Ids for deep links: /sesii and the weekly city page point at the
            digest; the calendar and erasure can be linked the same way. */}
        <div id="sedmichna" className="scroll-mt-4">
          <DigestPanel locale={locale} cities={digestCityList} subscribedIds={subscribedIds} />
        </div>

        <div id="kalendar" className="scroll-mt-4">
          <CalendarPanel token={feedToken} siteUrl={siteUrl()} />
        </div>

        {pushKey && (
          <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
            <h2 className="text-h4 font-bold text-ink">{tPush('profileTitle')}</h2>
            <p className="text-body-sm text-ink-soft">{tPush('profileText')}</p>
            <PushToggle publicKey={pushKey} labels={pushLabels} />
            {devices > 0 && (
              <form action={removeAllDevicesAction} className="space-y-2 border-t border-line pt-3">
                <p className="text-caption text-text-muted">
                  {tPush('devices', { count: devices })}
                </p>
                <Button type="submit" variant="secondary" size="sm">
                  {tPush('removeAll')}
                </Button>
              </form>
            )}
          </section>
        )}

        {/*
          GDPR Art. 15/20: the member's own copy, built by the same function the
          operator uses (lib/account-export.ts). A plain <a download> to a route
          handler, never <Link>: the response is a file, and a prefetch would
          build a whole export nobody asked for.
        */}
        <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
          <h2 className="text-h4 font-bold text-ink">{t('exportTitle')}</h2>
          <p className="text-body-sm text-ink-soft">{t('exportText')}</p>
          <a
            href="/api/profil/eksport"
            download
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            <Download size={15} />
            {t('exportLink')}
          </a>
          <p className="text-caption text-text-muted">{t('exportNote')}</p>
        </section>

        {/* Signing out is the end of the page, full width, where a thumb
            finds it — not a small ghost button among the pills at the top. */}
        <form action={signOutAction}>
          <Button type="submit" variant="secondary" block iconLeft={<LogOut size={18} />}>
            {t('signOut')}
          </Button>
        </form>

        <section
          id="iztrivane"
          className="scroll-mt-4 space-y-4 rounded-card border border-danger-border bg-danger-bg/40 p-4"
        >
          <h2 className="text-h4 font-bold text-danger">{t('deleteTitle')}</h2>

          <DeleteAccountForm confirmationWord={t('deleteConfirmWord')} clubs={clubsEnabled()} />
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
