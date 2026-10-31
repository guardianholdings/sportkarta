'use server';

import { getDb, type EventPromotion } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import {
  archiveEventTicket,
  cancelEvent,
  closeEventCheckouts,
  cancelEventPlace,
  publishEvent,
  registerForEvent,
  saveEvent,
  saveEventTicket,
} from '@/lib/clubs/events';
import { isUuid, parseEvent, parseEventRegistration, parseEventTicket } from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { clubTakesPayments } from '@/lib/clubs/payments';
import { revalidateClubSurfaces } from '@/lib/clubs/surfaces';
import {
  drawTournament,
  hideEntrantName,
  recordMatch,
  type MatchResult,
} from '@/lib/clubs/tournaments';
import { MATCH_SCORE_MAX, TOURNAMENT_FORMATS, type TournamentFormat } from '@sportkarta/lib/clubs';

/**
 * Events, camps and tournaments in the office (0053). Putting an event on —
 * its settings, tickets, publication and cancellation — is events.manage;
 * registering a person at the desk and giving a place up for them is
 * bookings.manage. Every statement carries its own scope; notices go after
 * the commit, ids only.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** `eventId` is a checked uuid or null (the new-event form); `rezultat` a code. */
async function back(slug: string, eventId: string | null, rezultat: string): Promise<never> {
  revalidatePath(`/klub/${slug}/sabitiya`);
  revalidateClubSurfaces(slug);
  return redirect({
    href: `/klub/${slug}/sabitiya/${eventId ?? 'novo'}?rezultat=${rezultat}`,
    locale: await getLocale(),
  });
}

async function tellPromoted(promotions: readonly EventPromotion[]): Promise<void> {
  if (promotions.length === 0) return;
  await enqueueClubNotify({
    kind: 'event_promoted',
    registrationIds: promotions.map((p) => p.registrationId),
  });
}

export async function saveEventAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'events.manage');
  const raw = str(formData, 'eventId');
  const eventId = isUuid(raw) ? raw : null;
  const parsed = parseEvent(formData, new Date());
  if (!parsed.ok) return back(slug, eventId, parsed.errors[0] ?? 'invalid');
  // An event people can only join by paying online needs a club that can take
  // the money; otherwise every registration would be refused.
  if (parsed.value.payment === 'online_required' && !(await clubTakesPayments(actor.clubId))) {
    return back(slug, eventId, 'online_unavailable');
  }
  const saved = await saveEvent(getDb(), actor, parsed.value, eventId);
  if (!saved.ok) return back(slug, eventId, saved.error);
  await tellPromoted(saved.promotions);
  return back(slug, saved.eventId, 'saved');
}

export async function saveTicketAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'events.manage');
  const eventId = str(formData, 'eventId');
  if (!isUuid(eventId)) return back(slug, null, 'not_found');
  const rawTicket = str(formData, 'ticketId');
  const parsed = parseEventTicket(formData);
  if (!parsed.ok) return back(slug, eventId, parsed.errors[0] ?? 'invalid');
  const saved = await saveEventTicket(
    getDb(),
    actor,
    eventId,
    parsed.value,
    isUuid(rawTicket) ? rawTicket : null,
  );
  if (!saved.ok) {
    return back(slug, eventId, saved.error === 'too_many' ? 'tickets_too_many' : saved.error);
  }
  await tellPromoted(saved.promotions);
  return back(slug, eventId, 'ticket_saved');
}

export async function archiveTicketAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'events.manage');
  const eventId = str(formData, 'eventId');
  const ticketId = str(formData, 'ticketId');
  if (!isUuid(eventId) || !isUuid(ticketId)) return back(slug, null, 'not_found');
  const ok = await archiveEventTicket(getDb(), actor, eventId, ticketId);
  return back(slug, eventId, ok ? 'ticket_saved' : 'not_allowed');
}

export async function publishEventAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'events.manage');
  const eventId = str(formData, 'eventId');
  if (!isUuid(eventId)) return back(slug, null, 'not_found');
  const result = await publishEvent(getDb(), actor, eventId);
  return back(slug, eventId, result === 'ok' ? 'published' : result);
}

export async function cancelEventAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'events.manage');
  const eventId = str(formData, 'eventId');
  if (!isUuid(eventId)) return back(slug, null, 'not_found');
  const result = await cancelEvent(getDb(), actor, eventId);
  if (!result.ok) return back(slug, eventId, 'not_allowed');
  // The people first, then the provider calls that close their payment pages.
  if (result.registrationIds.length > 0) {
    await enqueueClubNotify({ kind: 'event_cancelled', registrationIds: result.registrationIds });
  }
  await closeEventCheckouts(actor.clubId, result.chargeIds);
  return back(slug, eventId, result.invoiced > 0 ? 'event_cancelled_invoiced' : 'event_cancelled');
}

/** The desk registers a client — any record, before the event ends, outside the window. */
export async function deskRegisterAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'bookings.manage');
  const eventId = str(formData, 'eventId');
  if (!isUuid(eventId)) return back(slug, null, 'not_found');
  const parsed = parseEventRegistration(formData, str(formData, 'teamEvent') === '1');
  if (!parsed.ok) return back(slug, eventId, parsed.errors[0] ?? 'invalid');
  if (parsed.value.memberId === null) return back(slug, eventId, 'member_invalid');
  const result = await registerForEvent(getDb(), { kind: 'staff', actor }, eventId, parsed.value);
  if (!result.ok) return back(slug, eventId, result.error);
  await tellPromoted(result.promotions);
  await enqueueClubNotify({ kind: 'event_registered', registrationId: result.registrationId });
  return back(slug, eventId, result.state === 'waitlisted' ? 'registered_waitlist' : 'registered');
}

/** The desk gives a place up — never late; money paid is listed as owed back. */
export async function deskCancelPlaceAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'bookings.manage');
  const eventId = str(formData, 'eventId');
  const registrationId = str(formData, 'registrationId');
  if (!isUuid(eventId) || !isUuid(registrationId)) return back(slug, null, 'not_found');
  const result = await cancelEventPlace(getDb(), { kind: 'staff', actor }, registrationId);
  if (!result.ok) return back(slug, eventId, 'not_allowed');
  await tellPromoted(result.promotions);
  return back(
    slug,
    eventId,
    result.invoiceLive
      ? 'place_cancelled_invoice'
      : result.refundDue
        ? 'place_cancelled_refund'
        : 'place_cancelled',
  );
}

/** Hide an entrant's public name on their request — bookings.manage; never shows one. */
export async function hideEntrantNameAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'bookings.manage');
  const eventId = str(formData, 'eventId');
  const registrationId = str(formData, 'registrationId');
  if (!isUuid(eventId) || !isUuid(registrationId)) return back(slug, null, 'not_found');
  const ok = await hideEntrantName(getDb(), actor, registrationId);
  return back(slug, eventId, ok ? 'name_hidden' : 'not_allowed');
}

/** Draw (or re-draw, before any result) a tournament — events.manage. */
export async function drawTournamentAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'events.manage');
  const eventId = str(formData, 'eventId');
  if (!isUuid(eventId)) return back(slug, null, 'not_found');
  const format = str(formData, 'format');
  if (!(TOURNAMENT_FORMATS as readonly string[]).includes(format)) {
    return back(slug, eventId, 'format_invalid');
  }
  const seeding = str(formData, 'seeding') === 'rating' ? 'rating' : 'arrival';
  const result = await drawTournament(getDb(), actor, eventId, format as TournamentFormat, seeding);
  return back(slug, eventId, result.ok ? 'drawn' : `draw_${result.error}`);
}

/** A match's result: two scores, or a walkover for one side — events.results. */
export async function recordMatchAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'events.results');
  const eventId = str(formData, 'eventId');
  const matchId = str(formData, 'matchId');
  if (!isUuid(eventId) || !isUuid(matchId)) return back(slug, null, 'not_found');
  const walkover = str(formData, 'walkover');
  let result: MatchResult;
  if (walkover === 'a' || walkover === 'b') {
    result = { kind: 'walkover', winner: walkover };
  } else {
    const score = (name: string) => {
      const raw = str(formData, name);
      return /^\d{1,4}$/.test(raw) && Number(raw) <= MATCH_SCORE_MAX ? Number(raw) : null;
    };
    const scoreA = score('scoreA');
    const scoreB = score('scoreB');
    if (scoreA === null || scoreB === null) return back(slug, eventId, 'score_invalid');
    result = { kind: 'score', scoreA, scoreB };
  }
  const recorded = await recordMatch(getDb(), actor, eventId, matchId, result);
  return back(slug, eventId, recorded.ok ? 'result_saved' : `result_${recorded.error}`);
}
