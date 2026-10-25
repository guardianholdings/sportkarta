import { zonedToInstant, type WallClock } from '../recurrence/index.js';

import { addDaysIso, type IsoDate } from './dates.js';

/**
 * The slot engine (0048, wave C): which start times a service can be booked
 * at on one civil day. Pure — the caller reads opening hours and busy time
 * from the database; this decides.
 *
 * Starts step through the opening interval on the WALL CLOCK (09:00, 09:30, …)
 * and each is resolved to a real instant through the DST-aware zoned helpers:
 * a start that does not exist on the clock (the spring-forward gap) is never
 * offered, an ambiguous one (the autumn fold) is its first occurrence. A slot
 * is offered when
 *   - it starts no earlier than `notBefore` (now, plus any lead time),
 *   - the session ends by closing time (elapsed minutes — a 60-minute session
 *     is 60 real minutes even across a clock change),
 *   - the session PLUS its buffer overlaps nothing busy. Busy intervals are
 *     half-open [start, end): a booking may start the minute another ends.
 */

export interface OpeningHours {
  /** `HH:MM`, Sofia wall clock. */
  opens: string;
  closes: string;
}

/** A busy interval in epoch milliseconds, half-open. */
export interface BusyInterval {
  start: number;
  end: number;
  /** Units of a pool it takes (default 1; a closure takes them all). */
  units?: number;
}

export interface SlotQuery {
  date: IsoDate;
  timeZone: string;
  /** Null: closed that day. */
  hours: OpeningHours | null;
  durationMinutes: number;
  stepMinutes: number;
  /** Turnover after the session (a court's cleaning); 0 for a trainer. */
  bufferMinutes: number;
  busy: readonly BusyInterval[];
  notBefore: number;
}

export interface Slot {
  /** `HH:MM` on the club's wall clock — the key two lanes are intersected on. */
  local: string;
  startsAt: Date;
  endsAt: Date;
}

const MINUTE_MS = 60_000;

export function parseClock(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Midnight as a closing time: the END of the day, not its start. */
export const END_OF_DAY = 24 * 60;

/**
 * A closing time: `HH:MM`, or midnight — written `24:00`, or `00:00` as a
 * time input can only type it — meaning the end of the day. A booking never
 * runs past midnight (see priceFor), so this is as late as a day goes.
 */
export function parseClosing(text: string): number | null {
  if (/^(?:24:00|00:00)(?::00)?$/.test(text)) return END_OF_DAY;
  return parseClock(text);
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function wallAt(date: IsoDate, minutes: number): WallClock {
  const [year, month, day] = date.split('-').map(Number);
  return {
    year: year ?? 0,
    month: month ?? 1,
    day: day ?? 1,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  };
}

export function availableSlots(query: SlotQuery): Slot[] {
  if (!query.hours) return [];
  const opens = parseClock(query.hours.opens);
  const closes = parseClosing(query.hours.closes);
  if (opens === null || closes === null || closes <= opens) return [];
  if (query.durationMinutes <= 0 || query.stepMinutes <= 0) return [];
  const closing = zonedToInstant(
    closes === END_OF_DAY ? wallAt(addDaysIso(query.date, 1), 0) : wallAt(query.date, closes),
    query.timeZone,
  ).instantMs;
  const busy = [...query.busy].sort((a, b) => a.start - b.start);
  const slots: Slot[] = [];
  for (let at = opens; at < closes; at += query.stepMinutes) {
    const resolved = zonedToInstant(wallAt(query.date, at), query.timeZone);
    if (resolved.resolution === 'gap_shifted') continue;
    const start = resolved.instantMs;
    const end = start + query.durationMinutes * MINUTE_MS;
    if (end > closing) break;
    if (start < query.notBefore) continue;
    const claimEnd = end + query.bufferMinutes * MINUTE_MS;
    const clash = busy.some((b) => b.start < claimEnd && start < b.end);
    if (clash) continue;
    slots.push({ local: formatClock(at), startsAt: new Date(start), endsAt: new Date(end) });
  }
  return slots;
}

/** Starts offered by every lane (a trainer AND a room): the intersection by wall clock. */
export function intersectSlots(lanes: readonly (readonly Slot[])[]): Slot[] {
  if (lanes.length === 0) return [];
  const [first, ...rest] = lanes;
  return (first ?? []).filter((slot) =>
    rest.every((lane) => lane.some((s) => s.local === slot.local)),
  );
}

/** The durations a service sells: min..max in whole steps. */
export function serviceDurations(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let d = min; d <= max && out.length < 100; d += step) out.push(d);
  return out;
}

/**
 * When a POOL is fully taken: the stretches where at least `capacity` busy
 * intervals overlap (a sweep over half-open intervals — an end and a start
 * at the same instant do not overlap). These are the pool's busy time for
 * the slot engine; an exclusive resource is simply capacity 1.
 */
export function saturatedIntervals(
  intervals: readonly BusyInterval[],
  capacity: number,
): BusyInterval[] {
  if (capacity <= 1) return [...intervals];
  const events: [number, number][] = [];
  for (const i of intervals) {
    if (i.end <= i.start) continue;
    const units = i.units ?? 1;
    events.push([i.start, units], [i.end, -units]);
  }
  // Ends (negative) before starts at the same instant: half-open intervals
  // touch, not overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: BusyInterval[] = [];
  let count = 0;
  let openedAt: number | null = null;
  for (const [at, delta] of events) {
    count += delta;
    if (count >= capacity && openedAt === null) openedAt = at;
    else if (count < capacity && openedAt !== null) {
      const last = out[out.length - 1];
      // A hand-over at the same instant keeps the pool full: one stretch.
      if (last && last.end === openedAt) last.end = at;
      else if (at > openedAt) out.push({ start: openedAt, end: at });
      openedAt = null;
    }
  }
  return out;
}
