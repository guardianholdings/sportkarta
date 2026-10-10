'use client';

import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib/sports';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import { inReadingOrder } from '@/lib/format';
import { useFormAction } from '@/lib/use-form-action';

import { verifyFacilityAction, type ContributionState } from './contribution-actions';
import { ContributionThanks } from '@/components/facility/contribution-thanks';
import {
  PositionFields,
  PositionNotice,
  useContributeLocationLabels,
  usePosition,
} from '@/components/facility/position-fields';

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
  const { phase, latRef, lonRef, request } = usePosition();
  const locationLabels = useContributeLocationLabels();
  const tSport = useTranslations('Sport');
  const tAccess = useTranslations('Access');
  const tSurface = useTranslations('Surface');
  const locale = useLocale();
  // useFormAction: an error must not reset the checklist (lib/use-form-action.ts).
  const [state, formProps, pending] = useFormAction(verifyFacilityAction, INITIAL);
  const [exists, setExists] = useState(true);
  const sports = useMemo(
    () => inReadingOrder(CANONICAL_SPORTS, locale, (sport) => tSport(sport)),
    [locale, tSport],
  );
  const surfaces = useMemo(
    () => inReadingOrder(CANONICAL_SURFACES, locale, (surface) => tSurface(surface)),
    [locale, tSurface],
  );

  return (
    <form {...formProps} className="flex flex-col gap-5">
      <PositionFields latRef={latRef} lonRef={lonRef} />
      <PositionNotice phase={phase} labels={locationLabels} onRequest={request} />
      <input type="hidden" name="slug" value={props.slug} />
      {/* Declares which checklist fields this form presented; the action ignores
          anything not listed, so an omitted field can never be read as an
          assertion (and then frozen against imports). */}
      <input type="hidden" name="fields" value="access,surface,lighting,covered,sportTypes" />

      {/* CONTROLLED, and that matters: the checklist below exists only while
          the answer is «да». An uncontrolled radio was reset to «да» by React
          after a failed submit while `exists` stayed false — the checklist
          hidden, «да» shown — and the retry posted «да» with every declared
          field absent: `covered` recorded as false and a verification logged
          instead of the missing-facility report (UX audit 2026-10-10). */}
      <fieldset className="flex flex-col gap-2">
        <legend className={LEGEND}>{t('existsLegend')}</legend>
        <Radio
          name="exists"
          value="yes"
          label={t('existsYes')}
          checked={exists}
          onChange={() => setExists(true)}
        />
        <Radio
          name="exists"
          value="no"
          label={t('existsNo')}
          checked={!exists}
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
              {surfaces.map((value) => (
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
              {sports.map((sport) => (
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
      {state.status === 'ok' && <ContributionThanks state={state} kind="verify" />}
      {/* A change that would hide the facility (to «платен») is a proposal a
          moderator decides — said here, or the unchanged page reads as "not
          saved" (lib/contributions/verify-facility.ts gateHidingAccessChange). */}
      {state.status === 'ok' && state.accessProposed && (
        <p className="text-body-sm text-ink-soft">{t('accessProposedNote')}</p>
      )}

      <Button
        type="submit"
        disabled={pending}
        data-umami-event={ANALYTICS_EVENTS.contributionVerifySubmit}
      >
        {t('verifySubmit')}
      </Button>
    </form>
  );
}
