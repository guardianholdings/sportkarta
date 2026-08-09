'use client';

import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import { DISTANCE_SPORTS } from '@sportkarta/lib/training';
import { useActionState, useState } from 'react';

import { logTrainingAction, type TrainingFormState } from '@/app/[locale]/trenirovki/actions';

const EMPTY: TrainingFormState = { problems: [] };

/**
 * The manual training form (operator request 2026-07-26).
 *
 * A CLIENT COMPONENT for two reasons, neither of them decoration. The action
 * returns a LIST of problems rather than throwing on the first, so the member is
 * told everything that is wrong in one pass — that list has to land somewhere,
 * which is what `useActionState` is for. And the distance field appears only for
 * sports where a distance means something, which needs the selected sport before
 * submission. `useActionState` still submits without JavaScript, so this is not a
 * form that only works after hydration.
 *
 * There is deliberately NO field for `source` or `evidence`. Both are set
 * server-side from the fact that this is the manual form; a field for either
 * would let somebody post `source=garmin&evidence=qr_verified` and mint the top
 * evidence tier for a row they typed. Migration 0027 makes that combination
 * impossible at the database, and this form must not be the weaker layer.
 */
export function TrainingForm({
  strings,
  sportNames,
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
  sportNames: Record<string, string>;
  facilities: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(logTrainingAction, EMPTY);
  const [sport, setSport] = useState<string>('running');

  const showsDistance = (DISTANCE_SPORTS as readonly string[]).includes(sport);
  const field = 'w-full rounded border border-line-strong px-3 py-1.5 text-body-sm';

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-body-sm font-medium" htmlFor="sport">
            {strings.sport}
          </label>
          <select
            id="sport"
            name="sport"
            required
            value={sport}
            onChange={(event) => {
              setSport(event.target.value);
            }}
            className={field}
          >
            {CANONICAL_SPORTS.map((slug) => (
              <option key={slug} value={slug}>
                {sportNames[slug] ?? slug}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="block text-body-sm font-medium" htmlFor="startedAt">
            {strings.startedAt}
          </label>
          <input id="startedAt" name="startedAt" type="datetime-local" required className={field} />
        </div>

        <div className="space-y-1">
          <label className="block text-body-sm font-medium" htmlFor="duration">
            {strings.duration}
          </label>
          <input
            id="duration"
            name="duration"
            type="text"
            inputMode="numeric"
            required
            placeholder="45"
            className={field}
          />
          <p className="text-caption text-ink-soft">{strings.durationHint}</p>
        </div>

        {/*
          Distance appears only where it means something. Asking a climber for
          kilometres invites a number that is either blank or wrong, and a board
          that later ranks distance would inherit both.
        */}
        {showsDistance && (
          <div className="space-y-1">
            <label className="block text-body-sm font-medium" htmlFor="distanceKm">
              {strings.distanceKm}{' '}
              <span className="font-normal text-text-muted">{strings.optional}</span>
            </label>
            <input
              id="distanceKm"
              name="distanceKm"
              type="number"
              min={0}
              max={1000}
              className={field}
            />
          </div>
        )}

        <div className="space-y-1">
          <label className="block text-body-sm font-medium" htmlFor="elevationM">
            {strings.elevationM}{' '}
            <span className="font-normal text-text-muted">{strings.optional}</span>
          </label>
          <input
            id="elevationM"
            name="elevationM"
            type="number"
            min={0}
            max={30000}
            className={field}
          />
        </div>

        <div className="space-y-1">
          <label className="block text-body-sm font-medium" htmlFor="facilityId">
            {strings.facility}{' '}
            <span className="font-normal text-text-muted">{strings.optional}</span>
          </label>
          <select id="facilityId" name="facilityId" defaultValue="" className={field}>
            <option value="">{strings.facilityNone}</option>
            {facilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="block text-body-sm font-medium" htmlFor="note">
          {strings.note} <span className="font-normal text-text-muted">{strings.optional}</span>
        </label>
        <input id="note" name="note" type="text" maxLength={500} className={field} />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-pill bg-brand px-4 py-2 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover disabled:opacity-60"
      >
        {strings.submit}
      </button>

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
