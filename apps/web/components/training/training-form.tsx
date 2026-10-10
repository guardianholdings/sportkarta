'use client';

import { usesDistance } from '@sportkarta/lib/training';
import { useState } from 'react';

import { logTrainingAction, type TrainingFormState } from '@/app/[locale]/trenirovki/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useFormAction } from '@/lib/use-form-action';

const EMPTY: TrainingFormState = { problems: [] };

/** What the form opens on, and returns to after a save. */
const DEFAULT_SPORT = 'running';

/**
 * The manual training form (operator request 2026-07-26).
 *
 * A CLIENT COMPONENT for two reasons, neither of them decoration. The action
 * returns a LIST of problems rather than throwing on the first, so the member is
 * told everything that is wrong in one pass — that list has to land somewhere,
 * which is what the action state is for. And the distance field appears only for
 * sports where a distance means something, which needs the selected sport before
 * submission. The form still submits without JavaScript (useFormAction keeps the
 * `action` prop), so this is not a form that only works after hydration.
 *
 * WHAT A PROBLEM KEEPS. `useFormAction`, not a bare `useActionState`: React 19
 * resets a form once its action settles, so a "duration out of range" used to
 * come back above an EMPTY form — date, duration, distance, place and note all
 * gone (UX audit 2026-10-10, S-4). Only a SAVE clears it, for the next one; the
 * sport then returns to its default on both sides — the DOM select by the reset,
 * the distance field by `onReset` — so the two cannot disagree.
 *
 * There is deliberately NO field for `source` or `evidence`. Both are set
 * server-side from the fact that this is the manual form; a field for either
 * would let somebody post `source=garmin&evidence=qr_verified` and mint the top
 * evidence tier for a row they typed. Migration 0027 makes that combination
 * impossible at the database, and this form must not be the weaker layer.
 */
export function TrainingForm({
  strings,
  sports,
  facilities,
}: {
  strings: {
    sport: string;
    startedAt: string;
    duration: string;
    durationHint: string;
    distanceKm: string;
    elevationM: string;
    facility: string;
    facilityNone: string;
    note: string;
    submit: string;
    saved: string;
    optional: string;
    problems: Record<string, string>;
  };
  /** Every canonical sport, labelled and already in the reader's order. */
  sports: { value: string; label: string }[];
  facilities: { id: string; name: string }[];
}) {
  const [state, formProps, pending] = useFormAction(logTrainingAction, EMPTY, {
    resetWhen: (result) => result.saved === true,
  });
  const [sport, setSport] = useState<string>(DEFAULT_SPORT);

  const label = 'block text-body-sm font-medium';

  return (
    <form
      {...formProps}
      onReset={() => {
        setSport(DEFAULT_SPORT);
      }}
      className="space-y-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="sport">
            {strings.sport}
          </label>
          {/* Uncontrolled, so the post-save reset returns it to the default
              option rather than to whatever React last rendered. */}
          <Select
            id="sport"
            name="sport"
            required
            defaultValue={DEFAULT_SPORT}
            onChange={(event) => {
              setSport(event.target.value);
            }}
          >
            {sports.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1">
          <label className={label} htmlFor="startedAt">
            {strings.startedAt}
          </label>
          <Input id="startedAt" name="startedAt" type="datetime-local" required />
        </div>

        <div className="space-y-1">
          <label className={label} htmlFor="duration">
            {strings.duration}
          </label>
          <Input
            id="duration"
            name="duration"
            type="text"
            inputMode="numeric"
            required
            placeholder="45"
            aria-describedby="duration-hint"
          />
          <p id="duration-hint" className="text-caption text-ink-soft">
            {strings.durationHint}
          </p>
        </div>

        {/*
          Distance appears only where it means something. Asking a climber for
          kilometres invites a number that is either blank or wrong, and a board
          that later ranks distance would inherit both.

          TEXT with a decimal keypad, not type=number: a number input refused
          5,5 outright (no step) and, where it accepts a comma at all, does so
          by browser and locale. The action reads both «5,5» and «5.5»
          (parseDistanceKm), so what the member types is what is stored (S-3).
        */}
        {usesDistance(sport) && (
          <div className="space-y-1">
            <label className={label} htmlFor="distanceKm">
              {strings.distanceKm}{' '}
              <span className="font-normal text-text-muted">{strings.optional}</span>
            </label>
            <Input
              id="distanceKm"
              name="distanceKm"
              type="text"
              inputMode="decimal"
              autoComplete="off"
            />
          </div>
        )}

        <div className="space-y-1">
          <label className={label} htmlFor="elevationM">
            {strings.elevationM}{' '}
            <span className="font-normal text-text-muted">{strings.optional}</span>
          </label>
          <Input
            id="elevationM"
            name="elevationM"
            type="number"
            inputMode="numeric"
            min={0}
            max={30000}
          />
        </div>

        <div className="space-y-1">
          <label className={label} htmlFor="facilityId">
            {strings.facility}{' '}
            <span className="font-normal text-text-muted">{strings.optional}</span>
          </label>
          <Select id="facilityId" name="facilityId" defaultValue="">
            <option value="">{strings.facilityNone}</option>
            {facilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <label className={label} htmlFor="note">
          {strings.note} <span className="font-normal text-text-muted">{strings.optional}</span>
        </label>
        <Input id="note" name="note" type="text" maxLength={500} />
      </div>

      <Button type="submit" disabled={pending}>
        {strings.submit}
      </Button>

      {/*
        One live region for both outcomes, announced politely. EVERY problem is
        listed, because the action returns all of them — being told about the
        duration only after fixing the date is how a form gets abandoned.
      */}
      <div role="status" aria-live="polite" className="text-body-sm">
        {state.problems.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-danger">
            {state.problems.map((problem) => (
              <li key={problem}>{strings.problems[problem] ?? problem}</li>
            ))}
          </ul>
        )}
        {state.saved && <p className="font-medium text-success">{strings.saved}</p>}
      </div>
    </form>
  );
}
