import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { MapEmbed } from '@/components/admin/map-embed';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';
import { ACCESS_VALUES, facilityHistory, getFacility, STATUS_VALUES } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/auth-session';

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

  // Scoped: an ambassador may only open facilities in their municipalities.
  const user = await requireAdmin();
  const [t, tStatus, tAccess, tSport, tSurface, tSource, facility, history] = await Promise.all([
    getTranslations('AdminEdit'),
    getTranslations('AdminStatus'),
    getTranslations('Access'),
    getTranslations('Sport'),
    getTranslations('Surface'),
    getTranslations('Source'),
    getFacility({ id: user.id, role: user.role }, id),
    facilityHistory(id),
  ]);
  if (!facility) notFound();

  const saveWithId = saveFacility.bind(null, facility.id);

  return (
    <main className="space-y-4">
      <Link href="/admin/facilities" className="text-body-sm font-medium text-link hover:text-link-hover">
        {t('back')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      {saved !== null && (
        <p className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-body-sm text-success">
          {saved > 0 ? t('saved', { count: saved }) : t('savedNone')}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <form action={saveWithId} className="space-y-4 text-body-sm">
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
              {CANONICAL_SPORTS.map((sport) => (
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
              {CANONICAL_SURFACES.map((surface) => (
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
            <span className="text-caption font-medium text-ink-soft">{t('status')}</span>
            <Select name="status" defaultValue={facility.status}>
              {STATUS_VALUES.map((s) => (
                <option key={s} value={s}>
                  {tStatus(s)}
                </option>
              ))}
            </Select>
          </label>

          <Button type="submit">{t('save')}</Button>
        </form>

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
                    <span className="font-mono text-text-muted tabular-nums">{edit.createdAt.slice(0, 16)}</span> ·{' '}
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
