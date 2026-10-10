import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { MapEmbed } from '@/components/admin/map-embed';
import { ReasonSelect } from '@/components/admin/reason-select';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';
import { safeAdminBack } from '@/lib/admin-back';
import {
  ACCESS_VALUES,
  CONDITION_VALUES,
  facilityHistory,
  getFacility,
  municipalityOptions,
} from '@/lib/admin-data';
import { describeEditValue, isMarkerEdit, type EditValueWords } from '@/lib/admin-edit-values';
import { requireAdmin } from '@/lib/auth-session';
import { formatCoordinate } from '@/lib/facility-editor';
import { formatDateTime, formatNumber, inReadingOrder } from '@/lib/format';

import { decideFacility } from '../../moderation/actions';
import { saveFacility } from '../actions';
import { FacilityEditForm } from './facility-form';

const LIST = '/admin/facilities';

export default async function AdminFacilityEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  // The list the operator came from, filters and page included (A-9).
  const back = safeAdminBack(sp.back, LIST) ?? LIST;

  // Scoped: an ambassador may only open facilities in their municipalities.
  const user = await requireAdmin();
  const [
    t,
    tAccess,
    tSport,
    tSurface,
    tSource,
    tCondition,
    tStatus,
    tEdits,
    tModeration,
    tReason,
    facility,
    history,
  ] = await Promise.all([
    getTranslations('AdminEdit'),
    getTranslations('Access'),
    getTranslations('Sport'),
    getTranslations('Surface'),
    getTranslations('Source'),
    getTranslations('Condition'),
    getTranslations('AdminStatus'),
    getTranslations('AdminCrowdEdits'),
    getTranslations('AdminModeration'),
    getTranslations('ModerationReason'),
    getFacility({ id: user.id, role: user.role }, id),
    facilityHistory(id),
  ]);
  if (!facility) notFound();

  // A pin move also records the municipality it moved between, as ids.
  const municipalityNames = history.some((edit) => edit.field === 'municipality_id')
    ? new Map((await municipalityOptions()).map((m) => [m.id, m.nameBg]))
    : null;

  const label = (translate: typeof tAccess, value: string): string =>
    translate.has(value) ? translate(value) : value;
  const words: EditValueWords = {
    none: tEdits('valueNone'),
    yes: tEdits('valueYes'),
    no: tEdits('valueNo'),
    access: (value) => label(tAccess, value),
    status: (value) => label(tStatus, value),
    surface: (value) => label(tSurface, value),
    condition: (value) => label(tCondition, value),
    sport: (value) => label(tSport, value),
    municipality: (value) => municipalityNames?.get(value),
  };
  const fieldLabel = (field: string): string =>
    tEdits.has(`field.${field}`) ? tEdits(`field.${field}`) : field;
  const reasonLabel = (slug: string): string => (tReason.has(slug) ? tReason(slug) : slug);

  const saveWithId = saveFacility.bind(null, facility.id);
  const verify = decideFacility.bind(null, facility.id, 'verified' as const);
  const gone = decideFacility.bind(null, facility.id, 'gone' as const);
  // In the reader's alphabet, not the slugs' (football is «футбол», not «f»).
  const sports = inReadingOrder(CANONICAL_SPORTS, locale, (sport) => tSport(sport));
  const surfaces = inReadingOrder(CANONICAL_SURFACES, locale, (surface) => tSurface(surface));

  return (
    <main className="space-y-4">
      <Link href={back} className="text-body-sm font-medium text-link hover:text-link-hover">
        {t('back')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <FacilityEditForm action={saveWithId}>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-ink-soft">{t('name')}</span>
              <Input name="name" defaultValue={facility.name ?? ''} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-ink-soft">{t('quarter')}</span>
              <Input name="quarter" defaultValue={facility.quarter ?? ''} />
            </label>

            <fieldset className="space-y-1">
              <legend className="text-caption font-medium text-ink-soft">{t('sports')}</legend>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                {sports.map((sport) => (
                  <Checkbox
                    key={sport}
                    name="sports"
                    value={sport}
                    defaultChecked={facility.sportTypes.includes(sport)}
                    label={tSport(sport)}
                  />
                ))}
              </div>
            </fieldset>

            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-ink-soft">{t('surface')}</span>
              <Select name="surface" defaultValue={facility.surface ?? ''}>
                <option value="">{t('surfaceUnknown')}</option>
                {surfaces.map((surface) => (
                  <option key={surface} value={surface}>
                    {tSurface(surface)}
                  </option>
                ))}
              </Select>
            </label>

            <fieldset className="space-y-1">
              <legend className="text-caption font-medium text-ink-soft">{t('lighting')}</legend>
              <div className="flex gap-4">
                {(['yes', 'no', 'unknown'] as const).map((option) => (
                  <Radio
                    key={option}
                    name="lighting"
                    value={option}
                    defaultChecked={
                      facility.lighting === (option === 'yes') ||
                      (option === 'unknown' && facility.lighting === null)
                    }
                    label={
                      option === 'yes'
                        ? t('lightingYes')
                        : option === 'no'
                          ? t('lightingNo')
                          : t('lightingUnknown')
                    }
                  />
                ))}
              </div>
            </fieldset>

            <Checkbox name="covered" defaultChecked={facility.covered} label={t('covered')} />

            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-ink-soft">{t('access')}</span>
              <Select name="access" defaultValue={facility.access}>
                {ACCESS_VALUES.map((a) => (
                  <option key={a} value={a}>
                    {tAccess(a)}
                  </option>
                ))}
              </Select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-ink-soft">{t('condition')}</span>
              <Select name="condition" defaultValue={facility.condition ?? ''}>
                <option value="">{t('conditionNone')}</option>
                {CONDITION_VALUES.map((c) => (
                  <option key={c} value={c}>
                    {tCondition(c)}
                  </option>
                ))}
              </Select>
            </label>

            <fieldset className="space-y-1">
              <legend className="text-caption font-medium text-ink-soft">{t('location')}</legend>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-caption text-text-muted">{t('lat')}</span>
                  <Input
                    name="lat"
                    inputMode="decimal"
                    defaultValue={formatCoordinate(facility.lat)}
                    autoComplete="off"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-caption text-text-muted">{t('lon')}</span>
                  <Input
                    name="lon"
                    inputMode="decimal"
                    defaultValue={formatCoordinate(facility.lon)}
                    autoComplete="off"
                  />
                </label>
              </div>
              <p className="text-caption text-text-muted">
                {t('locationHelp', {
                  municipality: facility.municipalityName ?? t('noMunicipality'),
                })}
              </p>
            </fieldset>
          </FacilityEditForm>

          {/* The status is a moderation decision, not a field (A-4): logged with
              a reason, and explained to the author. A facility awaiting
              verification is decided here through that same path; any other
              status is shown, with where it is decided. */}
          <section
            aria-labelledby="status-h"
            className="space-y-3 rounded-card border border-line bg-surface p-4 text-body-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="status-h" className="text-caption font-medium text-ink-soft">
                {t('status')}
              </h2>
              <StatusBadge status={facility.status} />
            </div>
            <p className="text-caption text-text-muted">{t('statusReadOnly')}</p>
            {facility.status === 'needs_verification' ? (
              <div className="flex flex-wrap items-center gap-3">
                <form action={verify}>
                  <Button type="submit">{tModeration('verifyFacility')}</Button>
                </form>
                <form action={gone} className="flex flex-wrap items-center gap-2">
                  <ReasonSelect
                    context="facility_gone"
                    label={tModeration('reasonLabel')}
                    placeholder={tModeration('reasonPlaceholder')}
                    labelFor={reasonLabel}
                    size="md"
                  />
                  <ConfirmButton
                    className="inline-flex min-h-11 items-center rounded-pill bg-danger px-4 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-[color-mix(in_oklab,var(--danger),black_12%)]"
                    message={tModeration('markGoneConfirm')}
                  >
                    {tModeration('markGone')}
                  </ConfirmButton>
                </form>
              </div>
            ) : (
              <Link
                href="/admin/moderation"
                className="inline-flex min-h-11 items-center font-medium text-link hover:text-link-hover"
              >
                {t('statusToModeration')}
              </Link>
            )}
          </section>
        </div>

        <aside className="space-y-4 text-body-sm">
          <div>
            <h2 className="t-overline mb-1.5">{t('mapPreview')}</h2>
            <MapEmbed lon={facility.lon} lat={facility.lat} />
          </div>
          {facility.osmTags && (
            <details>
              <summary className="cursor-pointer font-medium text-ink-soft">{t('rawTags')}</summary>
              <pre className="mt-1 overflow-x-auto rounded-md bg-paper-sunk p-2 text-caption">
                {JSON.stringify(facility.osmTags, null, 2)}
              </pre>
            </details>
          )}
          <div>
            <h2 className="t-overline mb-1.5">{t('history')}</h2>
            {history.length === 0 ? (
              <p className="text-text-muted">{t('historyEmpty')}</p>
            ) : (
              <ul className="space-y-1 text-caption">
                {history.map((edit) => (
                  <li key={edit.id} className="rounded-md border border-line bg-surface p-2">
                    <span className="font-mono text-text-muted tabular-nums">
                      {formatDateTime(edit.createdAt, locale)}
                    </span>{' '}
                    ·{' '}
                    <span className="font-medium">
                      {edit.actor === null
                        ? tSource(edit.source)
                        : // An actor with no resolvable account: erased under
                          // GDPR, or a pre-accounts Stage 1 name. Either way the
                          // person is no longer identifiable from this row.
                          (edit.actorName ?? t('formerUser'))}
                    </span>{' '}
                    ·{' '}
                    {edit.field === 'created' ? (
                      t('historyCreated')
                    ) : (
                      <>
                        {edit.field === 'access_proposed' && (
                          // Filed for a moderator, never applied: a crowd
                          // "it is paid now", which would hide the facility
                          // (verify-facility.ts). Set Access above if it is true.
                          <span className="mr-1 rounded-pill bg-warning-bg px-1.5 text-warning">
                            {t('historyProposal')}
                          </span>
                        )}
                        {/* In words, as /admin/redakcii prints them — not the
                            raw JSON of the audit row (A-14). */}
                        <span className="font-medium">{fieldLabel(edit.field)}</span>
                        {!isMarkerEdit(edit.field) && (
                          <>
                            : {describeEditValue(edit.field, edit.oldValue, words)} →{' '}
                            {describeEditValue(edit.field, edit.newValue, words)}
                          </>
                        )}
                      </>
                    )}
                    {edit.distanceM !== null && (
                      <span className="text-text-muted">
                        {' '}
                        ·{' '}
                        {edit.distanceM >= 1000
                          ? t('historyDistanceKm', {
                              km: formatNumber(edit.distanceM / 1000, locale, {
                                maximumFractionDigits: 1,
                              }),
                            })
                          : t('historyDistanceM', { m: edit.distanceM })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
