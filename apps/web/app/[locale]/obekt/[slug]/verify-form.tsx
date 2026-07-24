'use client';

import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib/sports';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';

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

const LEGEND = 'mb-1 font-mono text-overline uppercase tracking-overline text-text-muted';
const FIELD_LABEL = 'font-mono text-overline uppercase tracking-overline text-text-muted';

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
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="slug" value={props.slug} />
      {/* Declares which checklist fields this form presented; the action ignores
          anything not listed, so an omitted field can never be read as an
          assertion (and then frozen against imports). */}
      <input type="hidden" name="fields" value="access,surface,lighting,covered,sportTypes" />

      <fieldset className="flex flex-col gap-2">
        <legend className={LEGEND}>{t('existsLegend')}</legend>
        <Radio
          name="exists"
          value="yes"
          label={t('existsYes')}
          defaultChecked
          onChange={() => setExists(true)}
        />
        <Radio
          name="exists"
          value="no"
          label={t('existsNo')}
          onChange={() => setExists(false)}
        />
        {!exists && <p className="text-caption text-text-muted">{t('existsNoHint')}</p>}
      </fieldset>

      {exists && (
        <>
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>{t('accessLabel')}</span>
            <Select name="access" defaultValue={props.access}>
              {ACCESS_VALUES.map((value) => (
                <option key={value} value={value}>
                  {tAccess(value)}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>{t('surfaceLabel')}</span>
            <Select name="surface" defaultValue={props.surface ?? ''}>
              <option value="">{t('surfaceUnknown')}</option>
              {CANONICAL_SURFACES.map((value) => (
                <option key={value} value={value}>
                  {tSurface(value)}
                </option>
              ))}
            </Select>
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className={LEGEND}>{t('lightingLabel')}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {(['yes', 'no', 'unknown'] as const).map((value) => (
                <Radio
                  key={value}
                  name="lighting"
                  value={value}
                  label={t(`lighting_${value}`)}
                  defaultChecked={
                    (props.lighting === true && value === 'yes') ||
                    (props.lighting === false && value === 'no') ||
                    (props.lighting === null && value === 'unknown')
                  }
                />
              ))}
            </div>
          </fieldset>

          <Checkbox name="covered" label={t('coveredLabel')} defaultChecked={props.covered} />

          <fieldset className="flex flex-col gap-2">
            <legend className={LEGEND}>{t('sportsLegend')}</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CANONICAL_SPORTS.map((sport) => (
                <Checkbox
                  key={sport}
                  name="sportTypes"
                  value={sport}
                  label={tSport(sport)}
                  defaultChecked={props.sportTypes.includes(sport)}
                />
              ))}
            </div>
          </fieldset>
        </>
      )}

      {state.status === 'error' && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error_${state.error ?? 'unknown'}`)}
        </p>
      )}
      {state.status === 'ok' && (
        <p role="status" className="text-body-sm text-success">
          {state.awarded ? t('thanksWithPoints', { points: state.awarded }) : t('thanksNoPoints')}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {t('verifySubmit')}
      </Button>
    </form>
  );
}
