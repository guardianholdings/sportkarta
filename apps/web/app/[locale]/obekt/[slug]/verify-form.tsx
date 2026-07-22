'use client';

import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib/sports';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';

import { verifyFacilityAction, type ContributionState } from './contribution-actions';

const ACCESS_VALUES = ['free', 'paid', 'restricted', 'school'] as const;
const INITIAL: ContributionState = { status: 'idle' };

export interface VerifyFormProps {
  slug: string;
  access: string;
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  sportTypes: string[];
}

/**
 * The verification checklist: prefilled with what the record currently says, so
 * confirming is one click and correcting is an edit rather than data entry.
 * Every change is attributed and audited server-side.
 */
export function VerifyForm(props: VerifyFormProps) {
  const t = useTranslations('Contribute');
  const tSport = useTranslations('Sport');
  const tAccess = useTranslations('Access');
  const tSurface = useTranslations('Surface');
  const [state, action, pending] = useActionState<ContributionState, FormData>(
    verifyFacilityAction,
    INITIAL,
  );
  const [exists, setExists] = useState(true);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="slug" value={props.slug} />
      {/* Declares which checklist fields this form presented; the action
          ignores anything not listed, so an omitted field can never be read as
          an assertion (and then frozen against imports). */}
      <input type="hidden" name="fields" value="access,surface,lighting,covered,sportTypes" />

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('existsLegend')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="exists"
            value="yes"
            defaultChecked
            onChange={() => {
              setExists(true);
            }}
          />
          {t('existsYes')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="exists"
            value="no"
            onChange={() => {
              setExists(false);
            }}
          />
          {t('existsNo')}
        </label>
        {!exists && <p className="text-xs text-neutral-500">{t('existsNoHint')}</p>}
      </fieldset>

      {exists && (
        <>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('accessLabel')}</span>
            <select
              name="access"
              defaultValue={props.access}
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
            <span className="text-sm font-medium">{t('surfaceLabel')}</span>
            <select
              name="surface"
              defaultValue={props.surface ?? ''}
              className="w-full rounded border border-neutral-300 px-3 py-2"
            >
              <option value="">{t('surfaceUnknown')}</option>
              {CANONICAL_SURFACES.map((value) => (
                <option key={value} value={value}>
                  {tSurface(value)}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t('lightingLabel')}</legend>
            {(['yes', 'no', 'unknown'] as const).map((value) => (
              <label key={value} className="mr-4 inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="lighting"
                  value={value}
                  defaultChecked={
                    (props.lighting === true && value === 'yes') ||
                    (props.lighting === false && value === 'no') ||
                    (props.lighting === null && value === 'unknown')
                  }
                />
                {t(`lighting_${value}`)}
              </label>
            ))}
          </fieldset>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="covered" defaultChecked={props.covered} />
            {t('coveredLabel')}
          </label>

          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t('sportsLegend')}</legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {CANONICAL_SPORTS.map((sport) => (
                <label key={sport} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="sportTypes"
                    value={sport}
                    defaultChecked={props.sportTypes.includes(sport)}
                  />
                  {tSport(sport)}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      )}

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-600">
          {t(`error_${state.error ?? 'unknown'}`)}
        </p>
      )}
      {state.status === 'ok' && (
        <p role="status" className="text-sm text-green-700">
          {state.awarded ? t('thanksWithPoints', { points: state.awarded }) : t('thanksNoPoints')}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {t('verifySubmit')}
      </Button>
    </form>
  );
}
