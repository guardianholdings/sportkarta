'use client';

import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { PinPicker } from '@/components/map/pin-picker';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

import { addFacilityAction, type AddFacilityState } from './actions';

const ACCESS_VALUES = ['free', 'paid', 'restricted', 'school'] as const;
const INITIAL: AddFacilityState = { error: null };

export function AddFacilityForm({
  initialLon,
  initialLat,
}: {
  initialLon: number;
  initialLat: number;
}) {
  const t = useTranslations('AddFacility');
  const tSport = useTranslations('Sport');
  const tAccess = useTranslations('Access');
  const [state, action, pending] = useActionState<AddFacilityState, FormData>(
    addFacilityAction,
    INITIAL,
  );

  return (
    <form action={action} className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('locationLegend')}</legend>
        <PinPicker initialLon={initialLon} initialLat={initialLat} />
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('photoLabel')}</span>
        <input
          type="file"
          name="photo"
          accept="image/jpeg,image/png,image/webp"
          required
          capture="environment"
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
        <span className="block text-xs text-neutral-500">{t('photoHint')}</span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('sportsLegend')}</legend>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {CANONICAL_SPORTS.map((sport) => (
            <label key={sport} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="sportTypes" value={sport} />
              {tSport(sport)}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('accessLabel')}</span>
        <select
          name="access"
          defaultValue="free"
          className="w-full rounded border border-neutral-300 px-3 py-2"
        >
          {ACCESS_VALUES.map((value) => (
            <option key={value} value={value}>
              {tAccess(value)}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('nameLabel')}</span>
        <input
          type="text"
          name="name"
          maxLength={120}
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
        <span className="block text-xs text-neutral-500">{t('nameHint')}</span>
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('quarterLabel')}</span>
        <input
          type="text"
          name="quarter"
          maxLength={80}
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {t(`error_${state.error}`)}{' '}
          {state.conflictSlug && (
            <Link href={`/obekt/${state.conflictSlug}`} className="underline">
              {t('seeExisting')}
            </Link>
          )}
        </p>
      )}

      <div className="space-y-2">
        <Button type="submit" disabled={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
        <p className="text-xs text-neutral-500">{t('moderationNote')}</p>
      </div>
    </form>
  );
}
