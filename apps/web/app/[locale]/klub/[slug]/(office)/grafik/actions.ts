'use server';

import { getDb } from '@sportkarta/db';
import { sofiaToday } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { bookAtDesk, cancelBooking } from '@/lib/clubs/bookings';
import { clubCheckIn } from '@/lib/clubs/checkin';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid, parseClass } from '@/lib/clubs/input';
import { enqueueClubMaterialize, enqueueClubNotify } from '@/lib/clubs/notify';
import {
  ClassRoomElsewhere,
  ClassRoomTaken,
  cancelClass,
  cancelOccurrence,
  classById,
  saveClass,
} from '@/lib/clubs/schedule';
import { revalidateClubSurfaces } from '@/lib/clubs/surfaces';
import { formatDateTime } from '@/lib/format';

export interface ScheduleState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
  /** The class's dates its room is already taken on (0048), Sofia `YYYY-MM-DD HH:MM`. */
  dates?: string[];
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function slugOf(formData: FormData): string {
  const slug = str(formData, 'slug');
  return /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

export async function saveClassAction(
  _prev: ScheduleState,
  formData: FormData,
): Promise<ScheduleState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const classIdRaw = str(formData, 'classId');
  const editing = isUuid(classIdRaw) ? await classById(actor, classIdRaw) : null;
  if (isUuid(classIdRaw) && !editing) return { error: 'readOnly' };
  const parsed = parseClass(formData, sofiaToday(), editing?.startsAtLocal.slice(0, 10) ?? null);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  let classId: string | null;
  try {
    classId = await saveClass(getDb(), actor, editing?.id ?? null, parsed.value);
  } catch (error: unknown) {
    // 0048: the room is taken on some of the class's dates — say which.
    if (error instanceof ClassRoomTaken) {
      const locale = await getLocale();
      return {
        error: 'room_taken',
        errors: ['room_taken'],
        dates: error.dates.map((at) => formatDateTime(at, locale)),
      };
    }
    if (error instanceof ClassRoomElsewhere) {
      return { error: 'room_location', errors: ['room_location'] };
    }
    throw error;
  }
  if (!classId) return { error: 'readOnly' };
  // The week fills in now, not at the top of the hour.
  await enqueueClubMaterialize(classId);
  revalidatePath(`/klub/${slug}/grafik`);
  revalidateClubSurfaces(slug);
  return redirect({ href: `/klub/${slug}/grafik`, locale: await getLocale() });
}

export async function cancelClassAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const classId = str(formData, 'classId');
  if (!isUuid(classId)) return;
  const affected = await cancelClass(getDb(), actor, classId);
  if (affected && affected.length > 0) {
    await enqueueClubNotify({ kind: 'class_cancelled', occurrenceIds: affected.slice(0, 500) });
  }
  revalidatePath(`/klub/${slug}/grafik`);
  revalidateClubSurfaces(slug);
  return redirect({ href: `/klub/${slug}/grafik`, locale: await getLocale() });
}

/** Operations on one occurrence's roster, dispatched by `op`. */
export async function rosterOpAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const occurrenceId = str(formData, 'occurrenceId');
  if (!isUuid(occurrenceId)) return;
  const op = str(formData, 'op');
  const db = getDb();
  let outcome = '';
  switch (op) {
    case 'present': {
      // A trainer may tick their own class; the check-in verifies that in SQL.
      const { actor } = await requireClubStaff(slug, 'schedule.view');
      const memberId = str(formData, 'memberId');
      if (!isUuid(memberId)) return;
      const result = await clubCheckIn(db, { method: 'desk', actor, memberId, occurrenceId });
      // Whether the client is covered is the desk's business (attendance.record);
      // a trainer ticking their own class learns only that the tick landed.
      outcome =
        result.status === 'recorded'
          ? result.covered || !actorCan(actor, 'attendance.record')
            ? 'checked_in'
            : 'checked_in_uncovered'
          : result.status === 'already'
            ? 'already_checked_in'
            : result.status;
      break;
    }
    case 'book': {
      const { actor } = await requireClubStaff(slug, 'bookings.manage');
      const memberId = str(formData, 'memberId');
      if (!isUuid(memberId)) return;
      const result = await bookAtDesk(db, actor, occurrenceId, memberId);
      if (result.ok) {
        outcome = result.status === 'going' ? 'booked' : 'waitlisted';
        if (result.status === 'going') {
          await enqueueClubNotify({ kind: 'booking_confirmed', bookingId: result.bookingId });
        }
      } else {
        outcome = result.error;
      }
      break;
    }
    case 'cancelBooking': {
      const { actor } = await requireClubStaff(slug, 'bookings.manage');
      const bookingId = str(formData, 'bookingId');
      if (!isUuid(bookingId)) return;
      const result = await cancelBooking(db, { kind: 'staff', actor }, bookingId);
      outcome = result.cancelled ? (result.late ? 'cancelled_late' : 'cancelled') : 'not_found';
      if (result.promoted.length > 0) {
        await enqueueClubNotify({ kind: 'booking_promoted', bookingIds: result.promoted });
      }
      break;
    }
    case 'cancelOccurrence': {
      const { actor } = await requireClubStaff(slug, 'schedule.manage');
      if (await cancelOccurrence(db, actor, occurrenceId)) {
        outcome = 'occurrence_cancelled';
        await enqueueClubNotify({ kind: 'class_cancelled', occurrenceIds: [occurrenceId] });
        revalidateClubSurfaces(slug);
      } else {
        outcome = 'readOnly';
      }
      break;
    }
    default:
      return;
  }
  revalidatePath(`/klub/${slug}/grafik/t/${occurrenceId}`);
  return redirect({
    href: { pathname: `/klub/${slug}/grafik/t/${occurrenceId}`, query: { rezultat: outcome } },
    locale: await getLocale(),
  });
}
