'use client';

import { CANONICAL_SPORTS, type CanonicalSport } from '@sportkarta/lib/sports';
import { Camera } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useRef, useState, type FormEvent } from 'react';

import { PinPicker, type PinPickerHandle } from '@/components/map/pin-picker';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import { SPORT_VISUALS } from '@/lib/design/sport-visuals';
import { inReadingOrder } from '@/lib/format';
import { useFormAction } from '@/lib/use-form-action';
import { Link } from '@/i18n/navigation';

import { addFacilityAction, type AddFacilityState } from './actions';
import { PhotoFieldStatus, usePhotoField } from '@/components/facility/photo-field';
import {
  PositionFields,
  PositionNotice,
  useContributeLocationLabels,
  usePosition,
} from '@/components/facility/position-fields';
import { PHOTO_ACCEPT } from '@/lib/photo-downscale';

const ACCESS_VALUES = ['free', 'paid', 'restricted', 'school'] as const;
const INITIAL: AddFacilityState = { error: null };

const LEGEND = 'font-mono text-overline uppercase tracking-overline text-text-muted';

/** What the form can tell is missing before it ever reaches the server. */
type Missing = 'pin' | 'sports';

export function AddFacilityForm({
  initialLon,
  initialLat,
  initiallyPlaced,
  paidHidden,
}: {
  initialLon: number;
  initialLat: number;
  /** The start came from the map ("add here") rather than the Sofia default. */
  initiallyPlaced: boolean;
  /** Paid venues are off the public map (`public_show_paid` is off). */
  paidHidden: boolean;
}) {
  const t = useTranslations('AddFacility');
  const locale = useLocale();
  const pin = useRef<PinPickerHandle>(null);
  // The member's own fix is the natural first guess for the pin of the pitch
  // they are standing at — see usePosition's `onFix`.
  const { phase, latRef, lonRef, request } = usePosition({
    onFix: (lat, lon) => pin.current?.offerFix(lon, lat),
  });
  const locationLabels = useContributeLocationLabels();
  const photo = usePhotoField();
  const tSport = useTranslations('Sport');
  const tAccess = useTranslations('Access');
  // useFormAction, not useActionState: a server-side error must not wipe the
  // photo, the name and the access choice (lib/use-form-action.ts).
  const [state, formProps, pending] = useFormAction(addFacilityAction, INITIAL);
  const [sports, setSports] = useState<Set<CanonicalSport>>(new Set());
  const [pinPlaced, setPinPlaced] = useState(initiallyPlaced);
  const [access, setAccess] = useState<string>('free');
  const [missing, setMissing] = useState<Missing | null>(null);
  const pinField = useRef<HTMLFieldSetElement>(null);
  const sportsField = useRef<HTMLFieldSetElement>(null);

  const sportsInOrder = useMemo(
    () => inReadingOrder(CANONICAL_SPORTS, locale, (sport) => tSport(sport)),
    [locale, tSport],
  );

  function toggleSport(s: CanonicalSport) {
    setSports((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
    if (missing === 'sports') setMissing(null);
  }

  /**
   * The two things the server would reject AFTER the member has picked a photo
   * and filled the form in — no point on the map, no sport — are caught here,
   * next to the field that needs them, instead of in a line at the bottom.
   * The server still checks both: this is help, not a guarantee.
   */
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const gap: Missing | null = !pinPlaced ? 'pin' : sports.size === 0 ? 'sports' : null;
    if (gap) {
      event.preventDefault();
      setMissing(gap);
      const field = gap === 'pin' ? pinField.current : sportsField.current;
      field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      field?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
      return;
    }
    setMissing(null);
    formProps.onSubmit(event);
  }

  return (
    <form {...formProps} onSubmit={onSubmit} className="flex flex-col gap-6">
      <PositionFields latRef={latRef} lonRef={lonRef} />
      <PositionNotice phase={phase} labels={locationLabels} onRequest={request} />
      <fieldset
        ref={pinField}
        className="flex flex-col gap-2"
        aria-describedby={missing === 'pin' ? 'add-pin-missing' : undefined}
      >
        <legend className={`mb-1 ${LEGEND}`}>{t('locationLegend')}</legend>
        <div className="overflow-hidden rounded-card border border-line">
          <PinPicker
            ref={pin}
            initialLon={initialLon}
            initialLat={initialLat}
            initiallyPlaced={initiallyPlaced}
            onPlaced={() => {
              setPinPlaced(true);
              setMissing((current) => (current === 'pin' ? null : current));
            }}
          />
        </div>
        {missing === 'pin' && (
          <p id="add-pin-missing" role="alert" className="text-body-sm text-danger">
            {t('pinRequired')}
          </p>
        )}
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className={LEGEND}>{t('photoLabel')}</span>
        <div className="flex items-center gap-2 rounded-input border border-line-strong bg-surface px-3 py-2.5 text-text-muted focus-within:border-brand">
          <Camera size={18} className="shrink-0 text-brand" />
          <input
            type="file"
            name="photo"
            accept={PHOTO_ACCEPT}
            required
            onChange={photo.onChange}
            className="min-w-0 flex-1 text-body-sm file:mr-3 file:rounded-pill file:border-0 file:bg-brand-subtle file:px-3 file:py-1 file:text-brand"
          />
        </div>
        <span className="text-caption text-text-muted">{t('photoHint')}</span>
        <PhotoFieldStatus status={photo.status} />
      </label>

      <fieldset
        ref={sportsField}
        className="flex flex-col gap-2"
        aria-describedby={missing === 'sports' ? 'add-sports-missing' : undefined}
      >
        <legend className={`mb-1 ${LEGEND}`}>{t('sportsLegend')}</legend>
        <div className="flex flex-wrap gap-2">
          {sportsInOrder.map((sport) => {
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
        {missing === 'sports' && (
          <p id="add-sports-missing" role="alert" className="text-body-sm text-danger">
            {t('error_sports_required')}
          </p>
        )}
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className={LEGEND}>{t('accessLabel')}</span>
        <Select name="access" value={access} onChange={(event) => setAccess(event.target.value)}>
          {ACCESS_VALUES.map((value) => (
            <option key={value} value={value}>
              {tAccess(value)}
            </option>
          ))}
        </Select>
        {/* Said BEFORE the add, not discovered after it: a paid venue is saved
            but stays off the public map while paid venues are hidden. */}
        {access === 'paid' && paidHidden && (
          <span className="text-caption text-text-muted">{t('paidHiddenHint')}</span>
        )}
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
