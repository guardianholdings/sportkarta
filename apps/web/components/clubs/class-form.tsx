'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';

import { FormFeedback } from './form-feedback';

/**
 * The class editor. The weekday picker builds FREQ=WEEKLY;BYDAY=… on the
 * server through lib/src/recurrence (apps/web/lib/clubs/input.ts), so the
 * grammar, the DST policy and the 0042 CHECKs agree with the materializer.
 */

export interface ScheduleState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
  /** Dates the chosen room is already taken (0048). */
  dates?: string[];
}

const INITIAL: ScheduleState = { error: null };
const label = 'block text-body-sm font-semibold text-ink';

export interface ClassFormLabels {
  title: string;
  description: string;
  sport: string;
  location: string;
  instructor: string;
  instructorNone: string;
  room: string;
  roomNone: string;
  roomHint: string;
  roomTaken: string;
  firstDate: string;
  time: string;
  duration: string;
  capacity: string;
  capacityHint: string;
  weekdays: string;
  weekdaysHint: string;
  weekdayNames: { code: string; label: string }[];
  ends: string;
  endsNever: string;
  endsUntil: string;
  endsCount: string;
  until: string;
  count: string;
  bookingTitle: string;
  bookingOpensDays: string;
  cancelDeadlineHours: string;
  dropInPrice: string;
  policyTitle: string;
  policyHint: string;
  noShowFee: string;
  lateCancelFee: string;
  strikeLimit: string;
  strikeDays: string;
  coverage: string;
  coverageAll: string;
  coverageSelected: string;
  trialAllowed: string;
  public: string;
  /** The fold over everything that has a default. */
  more: string;
  save: string;
}

export interface ClassValues {
  id: string;
  title: string;
  description: string | null;
  sport: string;
  locationId: string;
  instructorUserId: string | null;
  resourceId: string | null;
  firstDate: string;
  time: string;
  durationMinutes: number;
  capacity: number | null;
  weekdays: string[];
  ends: 'never' | 'until' | 'count';
  until: string;
  count: number | null;
  bookingOpensDays: number;
  cancelDeadlineHours: number;
  dropInPrice: string;
  noShowFee: string;
  lateCancelFee: string;
  strikeLimit: number | null;
  strikeDays: number | null;
  coversAllPlans: boolean;
  planIds: string[];
  trialAllowed: boolean;
  public: boolean;
}

export function ClassForm({
  action,
  slug,
  labels,
  messages,
  sports,
  locations,
  instructors,
  rooms = [],
  plans,
  today,
  defaults,
  value,
  clubSports = [],
}: {
  action: (prev: ScheduleState, formData: FormData) => Promise<ScheduleState>;
  slug: string;
  labels: ClassFormLabels;
  messages: ClubFormMessages;
  sports: { value: string; label: string }[];
  locations: { id: string; name: string }[];
  instructors: { userId: string; name: string }[];
  /** Rooms and courts (0048); the class claims the one chosen on each of its dates. */
  rooms?: { id: string; name: string; locationName: string }[];
  plans: { id: string; name: string }[];
  today: string;
  defaults: { bookingOpensDays: number; cancelDeadlineHours: number };
  value?: ClassValues;
  /** The sports the club chose (settings), the first of which a new class takes. */
  clubSports?: readonly string[];
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  const [ends, setEnds] = useState<ClassValues['ends']>(value?.ends ?? 'never');
  const [coverage, setCoverage] = useState(value && !value.coversAllPlans ? 'selected' : 'all');
  const advancedOpen =
    value !== undefined &&
    (value.instructorUserId !== null ||
      value.resourceId !== null ||
      value.ends !== 'never' ||
      value.bookingOpensDays !== defaults.bookingOpensDays ||
      value.cancelDeadlineHours !== defaults.cancelDeadlineHours ||
      value.dropInPrice !== '' ||
      !value.coversAllPlans ||
      !value.trialAllowed ||
      !value.public ||
      value.noShowFee !== '' ||
      value.lateCancelFee !== '' ||
      value.strikeLimit !== null ||
      (value.strikeDays !== null && value.strikeDays !== 30) ||
      (value.description ?? '') !== '');
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {value && <input type="hidden" name="classId" value={value.id} />}
      <FormFeedback state={state} messages={messages} />
      {state.dates && state.dates.length > 0 && (
        <p className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink">
          {labels.roomTaken} {state.dates.join(', ')}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="c-title">
            {labels.title}
          </label>
          <Input id="c-title" name="title" required maxLength={120} defaultValue={value?.title} />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="c-sport">
            {labels.sport}
          </label>
          <Select
            id="c-sport"
            name="sport"
            required
            // The club's own first sport (UX audit): the club chose its sports.
            defaultValue={value?.sport ?? clubSports[0] ?? ''}
          >
            <option value="" disabled>
              —
            </option>
            {sports.map((sport) => (
              <option key={sport.value} value={sport.value}>
                {sport.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="c-location">
            {labels.location}
          </label>
          <Select
            id="c-location"
            name="locationId"
            required
            defaultValue={value?.locationId ?? locations[0]?.id}
          >
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="space-y-1">
          <label className={label} htmlFor="c-date">
            {labels.firstDate}
          </label>
          <Input
            id="c-date"
            name="firstDate"
            type="date"
            required
            min={value && value.firstDate < today ? value.firstDate : today}
            defaultValue={value?.firstDate ?? today}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="c-time">
            {labels.time}
          </label>
          <Input
            id="c-time"
            name="time"
            type="time"
            required
            defaultValue={value?.time ?? '18:00'}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="c-duration">
            {labels.duration}
          </label>
          <Input
            id="c-duration"
            name="durationMinutes"
            type="number"
            min={15}
            max={480}
            step={5}
            required
            defaultValue={value?.durationMinutes ?? 60}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="c-capacity">
            {labels.capacity}
          </label>
          <Input
            id="c-capacity"
            name="capacity"
            type="number"
            min={1}
            max={500}
            defaultValue={value?.capacity ?? ''}
            aria-describedby="c-capacity-hint"
          />
          <p id="c-capacity-hint" className="text-caption text-text-muted">
            {labels.capacityHint}
          </p>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className={label}>{labels.weekdays}</legend>
        <div className="flex flex-wrap gap-2">
          {labels.weekdayNames.map((day) => (
            <label
              key={day.code}
              className="flex min-h-11 min-w-14 cursor-pointer items-center justify-center gap-1.5 rounded-pill border border-line-strong px-3 text-body-sm has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
            >
              <input
                type="checkbox"
                name="weekdays"
                value={day.code}
                defaultChecked={value?.weekdays.includes(day.code)}
                className="size-4 accent-[var(--brand)]"
              />
              {day.label}
            </label>
          ))}
        </div>
        <p className="text-caption text-text-muted">{labels.weekdaysHint}</p>
      </fieldset>
      {/*
        The essentials above are a class; everything below has a default
        (UX audit, «Office: add a class»: ~25 fields on first setup). Opened by
        itself when editing a class that already sets any of it, and when the
        server refused something — the field it names may be in here.
      */}
      <details
        open={advancedOpen || state.error !== null || Boolean(state.dates?.length)}
        className="group rounded-card border border-line p-3 [&[open]>summary]:mb-3"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center text-body-sm font-semibold text-link">
          {labels.more}
        </summary>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className={label} htmlFor="c-instructor">
                {labels.instructor}
              </label>
              <Select
                id="c-instructor"
                name="instructorUserId"
                defaultValue={value?.instructorUserId ?? ''}
              >
                <option value="">{labels.instructorNone}</option>
                {instructors.map((instructor) => (
                  <option key={instructor.userId} value={instructor.userId}>
                    {instructor.name}
                  </option>
                ))}
              </Select>
            </div>
            {rooms.length > 0 && (
              <div className="space-y-1">
                <label className={label} htmlFor="c-room">
                  {labels.room}
                </label>
                <Select id="c-room" name="resourceId" defaultValue={value?.resourceId ?? ''}>
                  <option value="">{labels.roomNone}</option>
                  {rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name} · {room.locationName}
                    </option>
                  ))}
                </Select>
                <p className="text-caption text-text-muted">{labels.roomHint}</p>
              </div>
            )}
          </div>
          <fieldset className="space-y-2">
            <legend className={label}>{labels.ends}</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['never', labels.endsNever],
                  ['until', labels.endsUntil],
                  ['count', labels.endsCount],
                ] as const
              ).map(([kind, text]) => (
                <label
                  key={kind}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border border-line-strong px-4 text-body-sm has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
                >
                  <input
                    type="radio"
                    name="ends"
                    value={kind}
                    checked={ends === kind}
                    onChange={() => setEnds(kind)}
                    className="size-4 accent-[var(--brand)]"
                  />
                  {text}
                </label>
              ))}
            </div>
            {ends === 'until' && (
              <label className="block max-w-xs text-body-sm text-ink">
                {labels.until}
                <Input
                  name="until"
                  type="date"
                  min={today}
                  defaultValue={value?.until ?? ''}
                  required
                />
              </label>
            )}
            {ends === 'count' && (
              <label className="block max-w-xs text-body-sm text-ink">
                {labels.count}
                <Input
                  name="count"
                  type="number"
                  min={1}
                  max={999}
                  defaultValue={value?.count ?? 10}
                  required
                />
              </label>
            )}
          </fieldset>
          <fieldset className="space-y-3 rounded-card border border-line p-3">
            <legend className="px-1 text-body-sm font-bold text-ink">{labels.bookingTitle}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <label className={label} htmlFor="c-opens">
                  {labels.bookingOpensDays}
                </label>
                <Input
                  id="c-opens"
                  name="bookingOpensDays"
                  type="number"
                  min={1}
                  max={90}
                  defaultValue={value?.bookingOpensDays ?? defaults.bookingOpensDays}
                />
              </div>
              <div className="space-y-1">
                <label className={label} htmlFor="c-deadline">
                  {labels.cancelDeadlineHours}
                </label>
                <Input
                  id="c-deadline"
                  name="cancelDeadlineHours"
                  type="number"
                  min={0}
                  max={168}
                  defaultValue={value?.cancelDeadlineHours ?? defaults.cancelDeadlineHours}
                />
              </div>
              <div className="space-y-1">
                <label className={label} htmlFor="c-dropin">
                  {labels.dropInPrice}
                </label>
                <Input
                  id="c-dropin"
                  name="dropInPrice"
                  inputMode="decimal"
                  defaultValue={value?.dropInPrice ?? ''}
                />
              </div>
            </div>
            <div className="space-y-2">
              <span className={label}>{labels.coverage}</span>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['all', labels.coverageAll],
                    ['selected', labels.coverageSelected],
                  ] as const
                ).map(([kind, text]) => (
                  <label
                    key={kind}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border border-line-strong px-4 text-body-sm has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
                  >
                    <input
                      type="radio"
                      name="coverage"
                      value={kind}
                      checked={coverage === kind}
                      onChange={() => setCoverage(kind)}
                      className="size-4 accent-[var(--brand)]"
                    />
                    {text}
                  </label>
                ))}
              </div>
              {coverage === 'selected' && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {plans.map((plan) => (
                    <Checkbox
                      key={plan.id}
                      name="planIds"
                      value={plan.id}
                      label={plan.name}
                      defaultChecked={value?.planIds.includes(plan.id)}
                    />
                  ))}
                </div>
              )}
            </div>
            <Checkbox
              name="trialAllowed"
              label={labels.trialAllowed}
              defaultChecked={value?.trialAllowed ?? true}
            />
            <Checkbox name="public" label={labels.public} defaultChecked={value?.public ?? true} />
          </fieldset>
          <fieldset className="space-y-3 rounded-card border border-line p-3">
            <legend className={`${label} px-1`}>{labels.policyTitle}</legend>
            <p className="text-caption text-text-muted">{labels.policyHint}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label className={label} htmlFor="c-noshow">
                  {labels.noShowFee}
                </label>
                <Input
                  id="c-noshow"
                  name="noShowFee"
                  inputMode="decimal"
                  defaultValue={value?.noShowFee ?? ''}
                />
              </div>
              <div className="space-y-1">
                <label className={label} htmlFor="c-latecancel">
                  {labels.lateCancelFee}
                </label>
                <Input
                  id="c-latecancel"
                  name="lateCancelFee"
                  inputMode="decimal"
                  defaultValue={value?.lateCancelFee ?? ''}
                />
              </div>
              <div className="space-y-1">
                <label className={label} htmlFor="c-strikes">
                  {labels.strikeLimit}
                </label>
                <Input
                  id="c-strikes"
                  name="strikeLimit"
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={value?.strikeLimit ?? ''}
                />
              </div>
              <div className="space-y-1">
                <label className={label} htmlFor="c-strike-days">
                  {labels.strikeDays}
                </label>
                <Input
                  id="c-strike-days"
                  name="strikeDays"
                  type="number"
                  min={7}
                  max={180}
                  defaultValue={value?.strikeDays ?? 30}
                />
              </div>
            </div>
          </fieldset>
          <div className="space-y-1">
            <label className={label} htmlFor="c-description">
              {labels.description}
            </label>
            <Textarea
              id="c-description"
              name="description"
              maxLength={2000}
              rows={3}
              defaultValue={value?.description ?? ''}
            />
          </div>
        </div>
      </details>
      <Button type="submit" disabled={pending || locations.length === 0}>
        {labels.save}
      </Button>
    </form>
  );
}
