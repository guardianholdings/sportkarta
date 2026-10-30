import {
  EVENT_CANCEL_HOURS_MAX,
  EVENT_CAPACITY_MAX,
  EVENT_DESCRIPTION_MAX,
  EVENT_KINDS,
  EVENT_PAYMENTS,
  EVENT_TITLE_MAX,
} from '@sportkarta/lib/clubs';
import { SOFIA_TZ, instantToWall } from '@sportkarta/lib/recurrence';
import { getTranslations } from 'next-intl/server';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ClubEvent } from '@/lib/clubs/events';

/** An instant as the Sofia wall-clock date and time a form shows. */
export function sofiaParts(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const wall = instantToWall(new Date(iso).getTime(), SOFIA_TZ);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${String(wall.year)}-${pad(wall.month)}-${pad(wall.day)}`,
    time: `${pad(wall.hour)}:${pad(wall.minute)}`,
  };
}

/**
 * The fields of an event (0053) — the office's create and edit forms share
 * them. Dates and times are the club's (Sofia) wall clock.
 */
export async function EventFields({
  slug,
  event,
  locations,
  resources,
  sports,
  drawn = false,
}: {
  slug: string;
  event: ClubEvent | null;
  locations: { id: string; name: string }[];
  resources: { id: string; name: string; locationId: string }[];
  sports: { value: string; label: string }[];
  /** A drawn tournament: kind, sport and team format stay (the save keeps them too). */
  drawn?: boolean;
}) {
  const t = await getTranslations('ClubEvents.form');
  const field = 'block text-body-sm font-semibold text-ink';
  const small = 'block text-caption text-ink-soft';
  const hint = 'mt-1 block text-caption font-normal text-text-muted';
  const check = 'flex min-h-11 items-center gap-2 text-body-sm text-ink';
  const starts = sofiaParts(event?.startsAt ?? null);
  const ends = sofiaParts(event?.endsAt ?? null);
  const opens = sofiaParts(event?.registrationOpensAt ?? null);
  const closes = sofiaParts(event?.registrationClosesAt ?? null);
  const locationName = (id: string) => locations.find((l) => l.id === id)?.name ?? '';

  return (
    <>
      <input type="hidden" name="slug" value={slug} />
      {event && <input type="hidden" name="eventId" value={event.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          {t('kind')}
          <Select
            name="kind"
            defaultValue={event?.kind ?? 'event'}
            className="mt-1"
            disabled={drawn}
          >
            {EVENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kinds.${kind}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className={field}>
          {t('sport')}
          <Select name="sport" defaultValue={event?.sport ?? ''} className="mt-1" disabled={drawn}>
            <option value="">{t('sportNone')}</option>
            {sports.map((sport) => (
              <option key={sport.value} value={sport.value}>
                {sport.label}
              </option>
            ))}
          </Select>
          <span className={hint}>{t('sportHint')}</span>
        </label>
      </div>
      {drawn && event && (
        <>
          {/* A disabled field is not sent: the kept values travel here. */}
          <input type="hidden" name="kind" value={event.kind} />
          <input type="hidden" name="sport" value={event.sport ?? ''} />
          {event.teamEvent && <input type="hidden" name="teamEvent" value="on" />}
          <p className="text-caption text-text-muted">{t('drawnLocked')}</p>
        </>
      )}
      <label className={field}>
        {t('titleBg')}
        <Input
          name="titleBg"
          required
          maxLength={EVENT_TITLE_MAX}
          defaultValue={event?.titleBg ?? ''}
          className="mt-1"
        />
      </label>
      <label className={field}>
        {t('titleEn')}
        <Input
          name="titleEn"
          maxLength={EVENT_TITLE_MAX}
          defaultValue={event?.titleEn ?? ''}
          className="mt-1"
        />
      </label>
      <label className={field}>
        {t('descriptionBg')}
        <Textarea
          name="descriptionBg"
          maxLength={EVENT_DESCRIPTION_MAX}
          rows={4}
          defaultValue={event?.descriptionBg ?? ''}
          className="mt-1"
        />
      </label>
      <label className={field}>
        {t('descriptionEn')}
        <Textarea
          name="descriptionEn"
          maxLength={EVENT_DESCRIPTION_MAX}
          rows={3}
          defaultValue={event?.descriptionEn ?? ''}
          className="mt-1"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          {t('location')}
          <Select
            name="locationId"
            defaultValue={event?.locationId ?? locations[0]?.id}
            className="mt-1"
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
        <label className={field}>
          {t('resource')}
          <Select name="resourceId" defaultValue={event?.resourceId ?? ''} className="mt-1">
            <option value="">{t('resourceNone')}</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {locationName(r.locationId)}
              </option>
            ))}
          </Select>
          <span className={hint}>{t('resourceHint')}</span>
        </label>
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-1 text-body-sm font-semibold text-ink">{t('when')}</legend>
        <label className={small}>
          {t('startDate')}
          <Input
            name="startDate"
            type="date"
            required
            defaultValue={starts.date}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('startTime')}
          <Input
            name="startTime"
            type="time"
            required
            defaultValue={starts.time}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('endDate')}
          <Input name="endDate" type="date" required defaultValue={ends.date} className="mt-1" />
        </label>
        <label className={small}>
          {t('endTime')}
          <Input name="endTime" type="time" required defaultValue={ends.time} className="mt-1" />
        </label>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-1 text-body-sm font-semibold text-ink">{t('window')}</legend>
        <label className={small}>
          {t('opensDate')}
          <Input name="opensDate" type="date" defaultValue={opens.date} className="mt-1" />
        </label>
        <label className={small}>
          {t('opensTime')}
          <Input name="opensTime" type="time" defaultValue={opens.time} className="mt-1" />
        </label>
        <label className={small}>
          {t('closesDate')}
          <Input name="closesDate" type="date" defaultValue={closes.date} className="mt-1" />
        </label>
        <label className={small}>
          {t('closesTime')}
          <Input name="closesTime" type="time" defaultValue={closes.time} className="mt-1" />
        </label>
        <span className="text-caption text-text-muted sm:col-span-4">{t('windowHint')}</span>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={field}>
          {t('capacity')}
          <Input
            name="capacity"
            type="number"
            min={1}
            max={EVENT_CAPACITY_MAX}
            defaultValue={event?.capacity ?? ''}
            className="mt-1"
          />
          <span className={hint}>{t('capacityHint')}</span>
        </label>
        <label className={field}>
          {t('payment')}
          <Select name="payment" defaultValue={event?.payment ?? 'desk'} className="mt-1">
            {EVENT_PAYMENTS.map((payment) => (
              <option key={payment} value={payment}>
                {t(`payments.${payment}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className={field}>
          {t('cancelHours')}
          <Input
            name="cancelHours"
            type="number"
            min={0}
            max={EVENT_CANCEL_HOURS_MAX}
            required
            defaultValue={event?.cancelDeadlineHours ?? 48}
            className="mt-1"
          />
          <span className={hint}>{t('cancelHoursHint')}</span>
        </label>
      </div>
      <label className={check}>
        <input
          type="checkbox"
          name="teamEvent"
          defaultChecked={event?.teamEvent ?? false}
          disabled={drawn}
          className="size-4 accent-[var(--brand)]"
        />
        {t('teamEvent')}
      </label>
      <label className={check}>
        <input
          type="checkbox"
          name="public"
          defaultChecked={event?.public ?? true}
          className="size-4 accent-[var(--brand)]"
        />
        {t('public')}
      </label>
    </>
  );
}
