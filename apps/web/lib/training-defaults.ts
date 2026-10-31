/**
 * What the training form opens on (UX audit, «Log a training»: five taps,
 * because the start time had no default and the duration was a placeholder).
 *
 * The member usually logs a training they have just finished, so the form
 * proposes one that ENDS now: it starts DEFAULT_TRAINING_MINUTES ago, rounded
 * down to five minutes, on the Sofia wall clock the action reads it as
 * (trenirovki/actions.ts, `sofiaWallClockToInstant`). Computed on the server,
 * so the page and the posted value agree whatever the phone's clock says.
 */
export const DEFAULT_TRAINING_MINUTES = 45;

/** `YYYY-MM-DDTHH:MM` in Europe/Sofia, the value a datetime-local input takes. */
export function defaultTrainingStart(now: Date = new Date()): string {
  const at = new Date(now.getTime() - DEFAULT_TRAINING_MINUTES * 60_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  const minute = String(Math.floor(Number(part('minute')) / 5) * 5).padStart(2, '0');
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${minute}`;
}
