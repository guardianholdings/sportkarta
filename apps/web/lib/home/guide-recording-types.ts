/**
 * The shapes of the front page's screen recordings, without the recordings:
 * the client player needs these, and importing them from the manifest's
 * module would ship the whole manifest to the browser a second time.
 */

/** The phone the screens were taken on, in CSS pixels. */
export const PHONE_WIDTH = 390;
export const PHONE_HEIGHT = 844;

export interface RecBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RecAction =
  | ({ type: 'tap'; on: 'screen' | 'bar' } & RecBox)
  | ({ type: 'mark' } & RecBox)
  | { type: 'scroll'; to: number };

export interface RecStep {
  src: string;
  w: number;
  h: number;
  /** Whether the bottom bar lies over this screen (a dialog's screen has it baked in). */
  bar: boolean;
  actions: RecAction[];
}

export interface Recording {
  bar: { src: string; w: number; h: number; top: number } | null;
  steps: RecStep[];
}
