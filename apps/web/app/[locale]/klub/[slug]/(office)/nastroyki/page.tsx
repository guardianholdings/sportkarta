import { CLUB_KINDS } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import {
  KioskCodeButton,
  KioskCreateForm,
  LocationForm,
  SettingsForm,
} from '@/components/clubs/settings-forms';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { cityDisplayName } from '@/lib/city-names';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { listKioskDevices } from '@/lib/clubs/kiosk';
import { clubSportOptions } from '@/lib/clubs/labels';
import {
  clubLocations,
  clubSettings,
  facilitiesInMunicipality,
  municipalityChoices,
} from '@/lib/clubs/settings';
import { formatDateTime } from '@/lib/format';
import { siteUrl } from '@/lib/seo';

import {
  createKioskAction,
  newPairingCodeAction,
  revokeKioskAction,
  saveLocationAction,
  saveSettingsAction,
  setLocationActiveAction,
  setVisibleAction,
  uploadLogoAction,
} from './actions';

export const dynamic = 'force-dynamic';

const EXPORTS = ['members', 'memberships', 'payments', 'checkins', 'classes', 'audit'] as const;

export default async function ClubSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ logo?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'settings.manage');
  const settings = await clubSettings(club.id);
  if (!settings) notFound();
  const [t, tClub, messages, locations, devices, cities, sportOptions] = await Promise.all([
    getTranslations('ClubSettings'),
    getTranslations('Club'),
    clubFormMessages(),
    clubLocations(actor, { includeArchived: true }),
    listKioskDevices(actor),
    municipalityChoices(),
    clubSportOptions(locale),
  ]);
  const linkedIds = locations.map((l) => l.facilityId).filter((id): id is string => id !== null);
  const facilities = await facilitiesInMunicipality(settings.municipalityId, linkedIds[0] ?? null);
  const { logo } = await searchParams;
  const origin = siteUrl();
  const publicUrl = `${origin}/klub/${slug}`;
  const kioskUrl = `${origin}/klub/${slug}/kiosk`;
  const activeLocations = locations.filter((l) => l.active);
  const kioskLabels = {
    name: t('kioskName'),
    location: t('kioskLocation'),
    create: t('kioskCreate'),
    newCode: t('kioskNewCode'),
    codeTemplate: t('kioskCode', { url: kioskUrl, code: '{code}' }),
  };
  const locationLabels = {
    name: t('locationName'),
    address: t('locationAddress'),
    facility: t('locationFacility'),
    facilityNone: t('facilityNone'),
    facilities: facilities.map((f) => ({ id: f.id, name: f.name })),
    submit: t('save'),
  };
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';

  return (
    <main className="space-y-6">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('publishTitle')}</h2>
        <p className="text-body-sm text-ink-soft">
          {settings.visible ? t('publishedOn', { url: publicUrl }) : t('publishedOff')}
        </p>
        <p className="text-caption text-text-muted">{t('publishHint')}</p>
        <form action={setVisibleAction}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="visible" value={settings.visible ? 'false' : 'true'} />
          <Button type="submit" variant={settings.visible ? 'secondary' : 'primary'}>
            {settings.visible ? t('unpublish') : t('publish')}
          </Button>
        </form>
      </section>

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('identityTitle')}</h2>
        <SettingsForm
          action={saveSettingsAction}
          slug={slug}
          messages={messages}
          labels={{
            nameBg: t('nameBg'),
            nameEn: t('nameEn'),
            kind: t('kind'),
            kinds: Object.fromEntries(CLUB_KINDS.map((kind) => [kind, tClub(`kind.${kind}`)])),
            descriptionBg: t('descriptionBg'),
            descriptionEn: t('descriptionEn'),
            sports: t('sports'),
            sportOptions,
            city: t('city'),
            cityNone: t('cityNone'),
            cities: cities.map((c) => ({
              id: c.id,
              name: cityDisplayName(c.nameBg, c.nameEn, locale),
            })),
            website: t('website'),
            publicEmail: t('publicEmail'),
            publicPhone: t('publicPhone'),
            publicContactHint: t('publicContactHint'),
            legalName: t('legalName'),
            eik: t('eik'),
            locale: t('locale'),
            localeBg: t('localeBg'),
            localeEn: t('localeEn'),
            bookingTitle: t('bookingTitle'),
            bookingOpensDays: t('bookingOpensDays'),
            cancelDeadlineHours: t('cancelDeadlineHours'),
            mailUnlinked: t('mailUnlinked'),
            mailUnlinkedHint: t('mailUnlinkedHint'),
            save: t('save'),
          }}
          values={settings}
        />
      </section>

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('logoTitle')}</h2>
        <p className="text-caption text-text-muted">{t('logoHint')}</p>
        {logo && logo !== 'saved' && (
          <p role="status" className="text-body-sm text-danger">
            {messages.errors[logo] ??
              (logo === 'readOnly' ? messages.readOnly : messages.genericError)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-4">
          {settings.logoPath && (
            // eslint-disable-next-line @next/next/no-img-element -- the row-decides logo route
            <img
              src={`/api/clubs/logo/${club.id}`}
              alt=""
              width={64}
              height={64}
              className="size-16 rounded-card border border-line object-contain"
            />
          )}
          <form action={uploadLogoAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="slug" value={slug} />
            <Input
              name="logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              required
              className="max-w-xs"
            />
            <Button type="submit" variant="secondary">
              {t('logoUpload')}
            </Button>
          </form>
        </div>
      </section>

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('locationsTitle')}</h2>
        <p className="text-caption text-text-muted">{t('locationsHint')}</p>
        {locations.length === 0 && <p className="text-body-sm text-ink-soft">{t('noLocations')}</p>}
        <ul className="divide-y divide-line">
          {locations.map((location) => (
            <li key={location.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink">
                  {location.name}{' '}
                  {!location.active && <Badge tone="neutral">{t('archived')}</Badge>}
                </span>
                <form action={setLocationActiveAction}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="locationId" value={location.id} />
                  <input type="hidden" name="active" value={location.active ? 'false' : 'true'} />
                  <Button type="submit" variant="ghost" size="sm">
                    {location.active ? t('archive') : t('restore')}
                  </Button>
                </form>
              </div>
              {location.facilityName && (
                <p className="text-caption text-text-muted">
                  {t('facilityLinked', { name: location.facilityName })}
                </p>
              )}
              {location.active && (
                <LocationForm
                  action={saveLocationAction}
                  slug={slug}
                  labels={locationLabels}
                  messages={messages}
                  location={location}
                />
              )}
            </li>
          ))}
        </ul>
        <div className="border-t border-line pt-3">
          <h3 className="mb-2 text-body font-bold text-ink">{t('addLocation')}</h3>
          <LocationForm
            action={saveLocationAction}
            slug={slug}
            labels={{ ...locationLabels, submit: t('addLocation') }}
            messages={messages}
          />
        </div>
      </section>

      <section id="kiosk" className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('kioskTitle')}</h2>
        <p className="text-caption text-text-muted">{t('kioskHint')}</p>
        {devices.length > 0 && (
          <ul className="divide-y divide-line">
            {devices.map((device) => (
              <li key={device.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div>
                  <span className="font-semibold text-ink">{device.name}</span>{' '}
                  <span className="text-caption text-text-muted">
                    {device.locationName} · {t(`kioskState.${device.state}`)}
                    {device.lastSeenAt
                      ? ` · ${t('kioskLastSeen', { date: formatDateTime(device.lastSeenAt, locale) })}`
                      : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {(device.state === 'pairing' || device.state === 'expired') && (
                    <KioskCodeButton
                      action={newPairingCodeAction}
                      slug={slug}
                      deviceId={device.id}
                      labels={kioskLabels}
                      messages={messages}
                    />
                  )}
                  {device.state !== 'revoked' && (
                    <form action={revokeKioskAction}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="deviceId" value={device.id} />
                      <ConfirmButton
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                        message={t('kioskRevokeConfirm')}
                      >
                        {t('kioskRevoke')}
                      </ConfirmButton>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <KioskCreateForm
          action={createKioskAction}
          slug={slug}
          labels={kioskLabels}
          messages={messages}
          locations={activeLocations.map((l) => ({ id: l.id, name: l.name }))}
        />
      </section>

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('dataTitle')}</h2>
        <p className="text-caption text-text-muted">{t('dataHint')}</p>
        <ul className="flex flex-wrap gap-2">
          {EXPORTS.map((dataset) => (
            <li key={dataset}>
              <a
                href={`/api/clubs/${slug}/eksport/${dataset}.csv`}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                download
              >
                {t('export')} · {dataset}.csv
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('closeTitle')}</h2>
        <p className="text-body-sm text-ink-soft">{t('closeHint')}</p>
      </section>
    </main>
  );
}
