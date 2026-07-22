import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { MapEmbed } from '@/components/admin/map-embed';
import { ACCESS_VALUES, facilityHistory, getFacility, STATUS_VALUES } from '@/lib/admin-data';

import { saveFacility } from '../actions';

export default async function AdminFacilityEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const savedRaw = (await searchParams).saved;
  const saved = typeof savedRaw === 'string' ? Number(savedRaw) : null;

  const [t, tStatus, tAccess, tSport, tSurface, tSource, facility, history] = await Promise.all([
    getTranslations('AdminEdit'),
    getTranslations('AdminStatus'),
    getTranslations('Access'),
    getTranslations('Sport'),
    getTranslations('Surface'),
    getTranslations('Source'),
    getFacility(id),
    facilityHistory(id),
  ]);
  if (!facility) notFound();

  const saveWithId = saveFacility.bind(null, facility.id);
  const inputClass = 'w-full rounded border border-neutral-300 px-3 py-2';

  return (
    <main className="space-y-4">
      <Link href="/admin/facilities" className="text-sm underline">
        {t('back')}
      </Link>
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {saved !== null && (
        <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {saved > 0 ? t('saved', { count: saved }) : t('savedNone')}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <form action={saveWithId} className="space-y-4 text-sm">
          <label className="block space-y-1">
            <span className="font-medium">{t('name')}</span>
            <input name="name" defaultValue={facility.name ?? ''} className={inputClass} />
          </label>
          <label className="block space-y-1">
            <span className="font-medium">{t('quarter')}</span>
            <input name="quarter" defaultValue={facility.quarter ?? ''} className={inputClass} />
          </label>

          <fieldset className="space-y-1">
            <legend className="font-medium">{t('sports')}</legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
              {CANONICAL_SPORTS.map((sport) => (
                <label key={sport} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="sports"
                    value={sport}
                    defaultChecked={facility.sportTypes.includes(sport)}
                  />
                  {tSport(sport)}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block space-y-1">
            <span className="font-medium">{t('surface')}</span>
            <select name="surface" defaultValue={facility.surface ?? ''} className={inputClass}>
              <option value="">{t('surfaceUnknown')}</option>
              {CANONICAL_SURFACES.map((surface) => (
                <option key={surface} value={surface}>
                  {tSurface(surface)}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="space-y-1">
            <legend className="font-medium">{t('lighting')}</legend>
            <div className="flex gap-4">
              {(['yes', 'no', 'unknown'] as const).map((option) => (
                <label key={option} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="lighting"
                    value={option}
                    defaultChecked={
                      facility.lighting === (option === 'yes') ||
                      (option === 'unknown' && facility.lighting === null)
                    }
                  />
                  {option === 'yes'
                    ? t('lightingYes')
                    : option === 'no'
                      ? t('lightingNo')
                      : t('lightingUnknown')}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" name="covered" defaultChecked={facility.covered} />
            {t('covered')}
          </label>

          <label className="block space-y-1">
            <span className="font-medium">{t('access')}</span>
            <select name="access" defaultValue={facility.access} className={inputClass}>
              {ACCESS_VALUES.map((a) => (
                <option key={a} value={a}>
                  {tAccess(a)}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="font-medium">{t('status')}</span>
            <select name="status" defaultValue={facility.status} className={inputClass}>
              {STATUS_VALUES.map((s) => (
                <option key={s} value={s}>
                  {tStatus(s)}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" className="rounded bg-neutral-900 px-6 py-3 font-medium text-white">
            {t('save')}
          </button>
        </form>

        <aside className="space-y-4 text-sm">
          <div>
            <h2 className="mb-1 font-medium">{t('mapPreview')}</h2>
            <MapEmbed lon={facility.lon} lat={facility.lat} />
          </div>
          {facility.osmTags && (
            <details>
              <summary className="cursor-pointer font-medium">{t('rawTags')}</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2 text-xs">
                {JSON.stringify(facility.osmTags, null, 2)}
              </pre>
            </details>
          )}
          <div>
            <h2 className="mb-1 font-medium">{t('history')}</h2>
            {history.length === 0 ? (
              <p className="text-neutral-500">{t('historyEmpty')}</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {history.map((edit) => (
                  <li key={edit.id} className="rounded border border-neutral-100 p-2">
                    <span className="text-neutral-500">{edit.createdAt.slice(0, 16)}</span> ·{' '}
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
                        <code>{edit.field}</code>: {JSON.stringify(edit.oldValue)} →{' '}
                        {JSON.stringify(edit.newValue)}
                      </>
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
