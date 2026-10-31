import {
  CLUB_CONTRACT_MONTHS,
  CLUB_CONTRACT_NOTICE_MONTHS,
  CLUB_KINDS,
  clubContractTerm,
  lowestTierWith,
  sofiaToday,
} from '@sportkarta/lib/clubs';
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
import { Select } from '@/components/ui/select';
import { cityDisplayName } from '@/lib/city-names';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubSwitchOn, featureOn } from '@/lib/clubs/features';
import { clubTrackingSettings } from '@/lib/clubs/tracking';
import { CLUB_EXPORT_DATASETS } from '@/lib/clubs/export';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { listKioskDevices } from '@/lib/clubs/kiosk';
import { clubSportOptions } from '@/lib/clubs/labels';
import { Textarea } from '@/components/ui/textarea';
import {
  MAX_FAQ,
  clubFaq,
  clubLocations,
  clubSettings,
  facilitiesInMunicipality,
  municipalityChoices,
} from '@/lib/clubs/settings';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  clubPaymentAccount,
  connectStartUrl,
  paymentProvider,
  paymentsReady,
} from '@/lib/clubs/payments';
import { siteUrl } from '@/lib/seo';
import { cn } from '@/lib/utils';
import { escapeHtml } from '@/lib/widget';
import { formErrorText } from '@/lib/clubs/form-error';

import {
  connectFakePaymentsAction,
  createKioskAction,
  disconnectPaymentsAction,
  newPairingCodeAction,
  removeFaqAction,
  saveFaqAction,
  revokeKioskAction,
  saveLocationAction,
  saveInvoiceDetailsAction,
  saveSettingsAction,
  saveTermsUrlAction,
  saveTrackingAction,
  setLocationActiveAction,
  setVisibleAction,
  uploadLogoAction,
} from './actions';

export const dynamic = 'force-dynamic';

/** ?plashtaniya= values the connect route and the payment actions send back. */
const PAYMENT_OUTCOMES = new Set([
  'connected',
  'connect_cancelled',
  'connect_failed',
  'disconnected',
  'terms_saved',
  'terms_invalid',
  'read_only',
  'subscriptions_live',
]);
const GOOD_OUTCOMES = new Set(['connected', 'disconnected', 'terms_saved']);

/** ?prosledyavane= values saveTrackingAction sends back (0058). */
const TRACKING_OUTCOMES = new Set([
  'saved',
  'feature_off',
  'ga_invalid',
  'meta_invalid',
  'privacy_invalid',
  'privacy_needed',
  'confirm_needed',
  'read_only',
]);

export default async function ClubSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{
    logo?: string;
    plashtaniya?: string;
    fakturi?: string;
    prosledyavane?: string;
  }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'settings.manage');
  const settings = await clubSettings(club.id);
  if (!settings) notFound();
  const { plashtaniya, fakturi, prosledyavane } = await searchParams;
  // The club's own pixels (0058): offered once the operator has switched them on.
  const pixelsSwitch = clubSwitchOn('pixels');
  const tracking = featureOn(club, 'pixels') ? await clubTrackingSettings(actor) : null;
  const paymentsOn = paymentsReady();
  const paymentAccount = paymentsOn ? await clubPaymentAccount(club.id) : null;
  const provider = paymentProvider();
  const [t, tClub, messages, locations, devices, cities, sportOptions, faq] = await Promise.all([
    getTranslations('ClubSettings'),
    getTranslations('Club'),
    clubFormMessages(),
    clubLocations(actor, { includeArchived: true }),
    listKioskDevices(actor),
    municipalityChoices(),
    clubSportOptions(locale),
    clubFaq(actor),
  ]);
  const faqFields = (
    entry: {
      questionBg: string;
      answerBg: string;
      questionEn: string | null;
      answerEn: string | null;
      sortOrder: number;
    } | null,
  ) => (
    <>
      <label className="block text-body-sm font-semibold text-ink">
        {t('faqQuestion')}
        <Input
          name="questionBg"
          required
          maxLength={200}
          defaultValue={entry?.questionBg ?? ''}
          className="mt-1"
        />
      </label>
      <label className="block text-body-sm font-semibold text-ink">
        {t('faqAnswer')}
        <Textarea
          name="answerBg"
          required
          maxLength={1500}
          rows={3}
          defaultValue={entry?.answerBg ?? ''}
          className="mt-1"
        />
      </label>
      <label className="block text-body-sm font-semibold text-ink">
        {t('faqQuestionEn')}
        <Input
          name="questionEn"
          maxLength={200}
          defaultValue={entry?.questionEn ?? ''}
          className="mt-1"
        />
      </label>
      <label className="block text-body-sm font-semibold text-ink">
        {t('faqAnswerEn')}
        <Textarea
          name="answerEn"
          maxLength={1500}
          rows={2}
          defaultValue={entry?.answerEn ?? ''}
          className="mt-1"
        />
      </label>
      <label className="block text-caption text-ink-soft">
        {t('faqOrder')}
        <Input
          name="sortOrder"
          type="number"
          min={0}
          max={999}
          size="sm"
          defaultValue={entry?.sortOrder ?? faq.length}
          className="mt-1 w-24"
        />
      </label>
    </>
  );
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
  // The contract is the operator's record (0061); the owner reads its terms here.
  const contract = clubContractTerm(
    { startsOn: settings.contract.startsOn, noticeOn: settings.contract.noticeOn },
    sofiaToday(),
  );
  const day = (date: string) => formatDate(date, locale);
  const contractText =
    contract.state === 'running' && settings.contract.startsOn
      ? t('contract.running', {
          start: day(settings.contract.startsOn),
          billing: settings.contract.billing ?? 'monthly',
          boundUntil: day(contract.boundUntil),
          noticeBy: day(contract.noticeBy),
          renewsOn: day(contract.renewsOn),
          months: CLUB_CONTRACT_MONTHS,
        })
      : contract.state === 'ending' || contract.state === 'ended'
        ? t(`contract.${contract.state}`, { endsOn: day(contract.endsOn) })
        : t('contract.none', { months: CLUB_CONTRACT_MONTHS });

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
            accent: t('accent'),
            accentHint: t('accentHint'),
            accents: {
              green: t('accents.green'),
              coral: t('accents.coral'),
              sky: t('accents.sky'),
            },
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
            {logo === 'readOnly' ? messages.readOnly : formErrorText(messages, logo)}
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
          {CLUB_EXPORT_DATASETS.map((dataset) => (
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

      <section className={section} aria-labelledby="faq-h">
        <h2 id="faq-h" className="text-h4 font-bold text-ink">
          {t('faqTitle')}
        </h2>
        <p className="text-caption text-text-muted">{t('faqHint', { max: MAX_FAQ })}</p>
        <ul className="space-y-2">
          {faq.map((entry) => (
            <li key={entry.id} className="rounded-card border border-line p-3">
              <details>
                <summary className="cursor-pointer text-body-sm font-semibold text-ink">
                  {entry.questionBg}
                </summary>
                <form action={saveFaqAction} className="mt-3 space-y-2">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="faqId" value={entry.id} />
                  {faqFields(entry)}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="secondary" size="sm">
                      {t('faqSave')}
                    </Button>
                  </div>
                </form>
                <form action={removeFaqAction} className="mt-2">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="faqId" value={entry.id} />
                  <ConfirmButton
                    message={t('faqRemoveConfirm')}
                    className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                  >
                    {t('faqRemove')}
                  </ConfirmButton>
                </form>
              </details>
            </li>
          ))}
        </ul>
        {faq.length < MAX_FAQ && (
          <details className="rounded-card border border-dashed border-line-strong p-3">
            <summary className="cursor-pointer text-body-sm font-semibold text-ink">
              {t('faqAdd')}
            </summary>
            <form action={saveFaqAction} className="mt-3 space-y-2">
              <input type="hidden" name="slug" value={slug} />
              {faqFields(null)}
              <Button type="submit" variant="secondary" size="sm">
                {t('faqSave')}
              </Button>
            </form>
          </details>
        )}
      </section>

      <section id="plashtaniya" className={section} aria-labelledby="pay-h">
        <h2 id="pay-h" className="text-h4 font-bold text-ink">
          {t('payments.title')}
        </h2>
        <div role="status" aria-live="polite">
          {plashtaniya && PAYMENT_OUTCOMES.has(plashtaniya) && (
            <p
              className={cn(
                'rounded-card border p-3 text-body-sm text-ink',
                GOOD_OUTCOMES.has(plashtaniya)
                  ? 'border-success-border bg-success-bg'
                  : 'border-warning-border bg-warning-bg',
              )}
            >
              {t(`payments.outcome.${plashtaniya}`)}
            </p>
          )}
        </div>
        {!paymentsOn ? (
          <p className="text-body-sm text-ink-soft">{t('payments.off')}</p>
        ) : paymentAccount ? (
          <div className="space-y-2">
            <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink">
              {paymentAccount.chargesEnabled ? (
                <Badge tone="success">{t('payments.live')}</Badge>
              ) : (
                <Badge tone="warning">{t('payments.pending')}</Badge>
              )}
              <span>
                {t('payments.connected', {
                  account: paymentAccount.accountRef,
                  date: formatDateTime(paymentAccount.connectedAt, locale),
                })}
              </span>
            </p>
            {!paymentAccount.chargesEnabled && (
              <p className="text-caption text-text-muted">{t('payments.pendingHint')}</p>
            )}
            {paymentAccount.provider === 'stripe' && (
              <p className="text-caption text-text-muted">{t('payments.dashboardHint')}</p>
            )}
            <form action={disconnectPaymentsAction}>
              <input type="hidden" name="slug" value={slug} />
              <ConfirmButton
                message={t('payments.disconnectConfirm')}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                {t('payments.disconnect')}
              </ConfirmButton>
            </form>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="max-w-prose text-body-sm text-ink-soft">{t('payments.intro')}</p>
            {provider === 'stripe' ? (
              <a
                href={connectStartUrl(actor) ?? '#'}
                className={buttonVariants({ variant: 'primary', size: 'sm' })}
              >
                {t('payments.connect')}
              </a>
            ) : (
              <form action={connectFakePaymentsAction}>
                <input type="hidden" name="slug" value={slug} />
                <Button type="submit" size="sm">
                  {t('payments.connectFake')}
                </Button>
              </form>
            )}
          </div>
        )}
        {paymentsOn && (
          <form action={saveTermsUrlAction} className="space-y-2 border-t border-line pt-3">
            <input type="hidden" name="slug" value={slug} />
            <label className="block text-body-sm font-semibold text-ink">
              {t('payments.termsUrl')}
              <Input
                name="termsUrl"
                inputMode="url"
                maxLength={300}
                placeholder="https://"
                defaultValue={settings.termsUrl ?? ''}
                className="mt-1"
              />
            </label>
            <p className="text-caption text-text-muted">{t('payments.termsHint')}</p>
            <Button type="submit" variant="secondary" size="sm">
              {t('payments.termsSave')}
            </Button>
          </form>
        )}
      </section>

      {featureOn(club, 'invoices') && (
        <section id="fakturi" className={section} aria-labelledby="invoices-h">
          <h2 id="invoices-h" className="text-h4 font-bold text-ink">
            {t('invoices.title')}
          </h2>
          <p className="text-caption text-text-muted">{t('invoices.hint')}</p>
          <div role="status" aria-live="polite">
            {fakturi && (
              <p
                className={cn(
                  'rounded-card border p-3 text-body-sm text-ink',
                  fakturi === 'saved'
                    ? 'border-success-border bg-success-bg'
                    : 'border-warning-border bg-warning-bg',
                )}
              >
                {fakturi === 'saved'
                  ? t('invoices.saved')
                  : fakturi === 'read_only'
                    ? messages.readOnly
                    : formErrorText(messages, fakturi)}
              </p>
            )}
          </div>
          <p className="text-body-sm text-ink">
            {settings.legalName && settings.eik
              ? t('invoices.identity', { name: settings.legalName, eik: settings.eik })
              : t('invoices.identityMissing')}
          </p>
          <form action={saveInvoiceDetailsAction} className="space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <label className="block text-body-sm font-semibold text-ink">
              {t('invoices.address')}
              <Input
                name="legalAddress"
                maxLength={300}
                defaultValue={settings.invoiceDetails.legalAddress ?? ''}
                className="mt-1"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-body-sm font-semibold text-ink">
                {t('invoices.vatNumber')}
                <Input
                  name="vatNumber"
                  maxLength={14}
                  placeholder="BG123456789"
                  defaultValue={settings.invoiceDetails.vatNumber ?? ''}
                  className="mt-1 uppercase"
                />
              </label>
              <label className="block text-body-sm font-semibold text-ink sm:col-span-2">
                {t('invoices.iban')}
                <Input
                  name="iban"
                  maxLength={40}
                  defaultValue={settings.invoiceDetails.iban ?? ''}
                  className="mt-1 uppercase"
                />
              </label>
            </div>
            <label className="block text-body-sm font-semibold text-ink">
              {t('invoices.vatRate')}
              <Select
                name="invoiceVatBp"
                defaultValue={String(settings.invoiceDetails.invoiceVatBp)}
                className="mt-1"
              >
                {[2000, 900, 0].map((rate) => (
                  <option key={rate} value={rate}>
                    {t('invoices.rate', { rate: rate / 100 })}
                  </option>
                ))}
              </Select>
              <span className="mt-1 block text-caption font-normal text-text-muted">
                {t('invoices.vatRateHint')}
              </span>
            </label>
            <label className="block text-body-sm font-semibold text-ink">
              {t('invoices.zeroBasis')}
              <Input
                name="zeroVatBasis"
                maxLength={200}
                defaultValue={settings.invoiceDetails.zeroVatBasis ?? ''}
                className="mt-1"
              />
              <span className="mt-1 block text-caption font-normal text-text-muted">
                {t('invoices.zeroBasisHint')}
              </span>
            </label>
            <Button type="submit" variant="secondary" size="sm">
              {t('invoices.save')}
            </Button>
          </form>
        </section>
      )}

      {pixelsSwitch && (
        <section id="prosledyavane" className={section} aria-labelledby="tracking-h">
          <h2 id="tracking-h" className="text-h4 font-bold text-ink">
            {t('tracking.title')}
          </h2>
          {tracking === null ? (
            <p className="max-w-prose text-body-sm text-ink-soft">
              {t('tracking.upsell', { tier: tClub(`tier.${lowestTierWith('pixels')}`) })}
            </p>
          ) : (
            <>
              <p className="max-w-prose text-caption text-text-muted">{t('tracking.hint')}</p>
              <div role="status" aria-live="polite">
                {prosledyavane && TRACKING_OUTCOMES.has(prosledyavane) && (
                  <p
                    className={cn(
                      'rounded-card border p-3 text-body-sm text-ink',
                      prosledyavane === 'saved'
                        ? 'border-success-border bg-success-bg'
                        : 'border-warning-border bg-warning-bg',
                    )}
                  >
                    {prosledyavane === 'read_only'
                      ? messages.readOnly
                      : t(`tracking.outcome.${prosledyavane}`)}
                  </p>
                )}
              </div>
              <form action={saveTrackingAction} className="space-y-3">
                <input type="hidden" name="slug" value={slug} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-body-sm font-semibold text-ink">
                    {t('tracking.ga')}
                    <Input
                      name="gaId"
                      maxLength={20}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="G-XXXXXXXXXX"
                      defaultValue={tracking.gaId ?? ''}
                      className="mt-1"
                    />
                  </label>
                  <label className="block text-body-sm font-semibold text-ink">
                    {t('tracking.meta')}
                    <Input
                      name="metaId"
                      maxLength={30}
                      inputMode="numeric"
                      autoComplete="off"
                      spellCheck={false}
                      defaultValue={tracking.metaId ?? ''}
                      className="mt-1"
                    />
                  </label>
                </div>
                <label className="block text-body-sm font-semibold text-ink">
                  {t('tracking.privacy')}
                  <span className="mt-1 block text-caption font-normal text-text-muted">
                    {t('tracking.privacyHint')}
                  </span>
                  <Input
                    name="privacyUrl"
                    inputMode="url"
                    maxLength={300}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://"
                    defaultValue={tracking.privacyUrl ?? ''}
                    className="mt-1"
                  />
                </label>
                <p className="max-w-prose text-caption text-text-muted">{t('tracking.where')}</p>
                <label className="flex min-h-11 items-start gap-2 text-body-sm text-ink">
                  <input type="checkbox" name="responsible" className="mt-1 size-5 shrink-0" />
                  <span>{t('tracking.responsible')}</span>
                </label>
                <Button type="submit">{t('save')}</Button>
              </form>
            </>
          )}
        </section>
      )}

      <section className={section} aria-labelledby="share-h">
        <h2 id="share-h" className="text-h4 font-bold text-ink">
          {t('shareTitle')}
        </h2>
        <p className="text-body-sm text-ink-soft">
          {t('shortLink')}{' '}
          <code className="rounded bg-paper-sunk px-1.5 py-0.5 text-caption">
            {`${siteUrl().replace(/^https?:\/\//, '')}/k/${slug}`}
          </code>
        </p>
        {featureOn(club, 'embeds') ? (
          <div className="space-y-2">
            <p className="text-caption text-text-muted">{t('embedHint')}</p>
            {(['grafik', 'ceni'] as const).map((kind) => (
              <div key={kind} className="space-y-1">
                <p className="text-caption font-semibold text-ink">{t(`embed.${kind}`)}</p>
                <pre className="overflow-x-auto rounded-card bg-paper-sunk p-2 text-caption">
                  {`<iframe src="${siteUrl()}/api/widget/klub/${slug}/${kind}" title="${escapeHtml(settings.nameBg)}" width="100%" height="480" style="border:0" loading="lazy"></iframe>`}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-caption text-text-muted">{t('embedUpsell')}</p>
        )}
      </section>

      <section id="dogovor" className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('contractTitle')}</h2>
        <p className="text-body-sm text-ink-soft">{contractText}</p>
      </section>

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('closeTitle')}</h2>
        <p className="text-body-sm text-ink-soft">
          {contract.state === 'none'
            ? t('closeHint')
            : t('closeHintContract', { notice: CLUB_CONTRACT_NOTICE_MONTHS })}
        </p>
      </section>
    </main>
  );
}
