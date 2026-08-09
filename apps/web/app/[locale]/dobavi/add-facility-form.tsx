'use client';

import { CANONICAL_SPORTS, type CanonicalSport } from '@sportkarta/lib/sports';
import { Camera } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { PinPicker } from '@/components/map/pin-picker';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import { SPORT_VISUALS } from '@/lib/design/sport-visuals';
import { Link } from '@/i18n/navigation';

import { addFacilityAction, type AddFacilityState } from './actions';
import { PositionFields, PositionNotice, usePosition } from '@/components/facility/position-fields';

const ACCESS_VALUES = ['free', 'paid', 'restricted', 'school'] as const;
const INITIAL: AddFacilityState = { error: null };

const LEGEND = 'font-mono text-overline uppercase tracking-overline text-text-muted';

export function AddFacilityForm({
  initialLon,
  initialLat,
}: {
  initialLon: number;
  initialLat: number;
}) {
  const t = useTranslations('AddFacility');
  const tContribute = useTranslations('Contribute');
  const { phase, latRef, lonRef, request } = usePosition();
  const tSport = useTranslations('Sport');
  const tAccess = useTranslations('Access');
  const [state, action, pending] = useActionState<AddFacilityState, FormData>(
    addFacilityAction,
    INITIAL,
  );
  const [sports, setSports] = useState<Set<CanonicalSport>>(new Set());

  function toggleSport(s: CanonicalSport) {
    setSports((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      <PositionFields latRef={latRef} lonRef={lonRef} />
      <PositionNotice
        phase={phase}
        labels={{
          locating: tContribute('locating'),
          granted: tContribute('locationGranted'),
          denied: tContribute('locationDenied'),
          insecure: tContribute('locationInsecure'),
          retry: tContribute('locationRetry'),
        }}
        onRequest={request}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className={`mb-1 ${LEGEND}`}>{t('locationLegend')}</legend>
        <div className="overflow-hidden rounded-card border border-line">
          <PinPicker initialLon={initialLon} initialLat={initialLat} />
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className={LEGEND}>{t('photoLabel')}</span>
        <div className="flex items-center gap-2 rounded-input border border-line-strong bg-surface px-3 py-2.5 text-text-muted focus-within:border-brand">
          <Camera size={18} className="shrink-0 text-brand" />
          <input
            type="file"
            name="photo"
            accept="image/jpeg,image/png,image/webp"
            required
            capture="environment"
            className="min-w-0 flex-1 text-body-sm file:mr-3 file:rounded-pill file:border-0 file:bg-brand-subtle file:px-3 file:py-1 file:text-brand"
          />
        </div>
        <span className="text-caption text-text-muted">{t('photoHint')}</span>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className={`mb-1 ${LEGEND}`}>{t('sportsLegend')}</legend>
        <div className="flex flex-wrap gap-2">
          {CANONICAL_SPORTS.map((sport) => {
            const v = SPORT_VISUALS[sport];
            return (
              <Chip
                key={sport}
                color={v.color}
                selected={sports.has(sport)}
                icon={<v.Icon size={15} />}
                onClick={() => toggleSport(sport)}
              >
                {tSport(sport)}
              </Chip>
            );
          })}
        </div>
        {[...sports].map((s) => (
          <input key={s} type="hidden" name="sportTypes" value={s} />
        ))}
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className={LEGEND}>{t('accessLabel')}</span>
        <Select name="access" defaultValue="free">
          {ACCESS_VALUES.map((value) => (
            <option key={value} value={value}>
              {tAccess(value)}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={LEGEND}>{t('nameLabel')}</span>
        <Input name="name" maxLength={120} />
        <span className="text-caption text-text-muted">{t('nameHint')}</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={LEGEND}>{t('quarterLabel')}</span>
        <Input name="quarter" maxLength={80} />
      </label>

      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error_${state.error}`)}{' '}
          {state.conflictSlug && (
            <Link
              href={`/obekt/${state.conflictSlug}`}
              className="font-medium text-link hover:text-link-hover"
            >
              {t('seeExisting')}
            </Link>
          )}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Button
          type="submit"
          size="lg"
          block
          disabled={pending}
          data-umami-event={ANALYTICS_EVENTS.contributionAddSubmit}
        >
          {pending ? t('submitting') : t('submit')}
        </Button>
        <p className="text-caption text-text-muted">{t('moderationNote')}</p>
      </div>
    </form>
  );
}
