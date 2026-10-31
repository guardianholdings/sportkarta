import type { Recording } from './guide-recording-types';
import manifest from './guide-recordings.json';

export { PHONE_HEIGHT, PHONE_WIDTH } from './guide-recording-types';
export type { RecAction, RecBox, RecStep, Recording } from './guide-recording-types';

/**
 * The front page's screen recordings (components/guide/screen-recording.tsx),
 * as scripts/marketing-shots/guide.mjs wrote them: per flow and language, the
 * phone screens in order, each with what happens on it. Every box is in CSS
 * pixels of a 390-wide phone, measured on the picture itself (a tall page is
 * one picture that scrolls), or on the bottom-bar strip for `on: 'bar'`.
 */

export const RECORDING_KEYS = ['find', 'add', 'verify', 'play', 'passport'] as const;
export type RecordingKey = (typeof RECORDING_KEYS)[number];

type Manifest = Partial<Record<RecordingKey, Partial<Record<string, Recording>>>>;

/** One flow in one language; English falls back to the Bulgarian screens. */
export function recordingFor(key: RecordingKey, locale: string): Recording | null {
  const flow = (manifest as Manifest)[key];
  return flow?.[locale] ?? flow?.bg ?? null;
}
