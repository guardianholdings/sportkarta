import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PHONE_WIDTH,
  RECORDING_KEYS,
  recordingFor,
  type RecAction,
} from '@/lib/home/guide-recordings';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The front page's screen recordings (scripts/marketing-shots/guide.mjs →
 * lib/home/guide-recordings.json + public/guide). The page writes every step
 * out as text beside the film, so the manifest and the captions must agree
 * step for step, every picture must be on disk, every touch and highlight must
 * land on its picture, and the pictures must stay light enough for a phone.
 */

const PUBLIC = path.join(__dirname, '..', 'public');
const CATALOGUES = { bg, en } as const;
const size = (src: string) => statSync(path.join(PUBLIC, src)).size;

describe.each(Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[])(
  'recordings (%s)',
  (locale) => {
    const captions = CATALOGUES[locale].Home.guide.recordings as Record<
      string,
      Record<string, unknown>
    >;

    it.each([...RECORDING_KEYS])('%s has its own screens, captioned step for step', (key) => {
      const recording = recordingFor(key, locale);
      expect(recording).not.toBeNull();
      const steps = recording?.steps ?? [];
      expect(steps.length).toBeGreaterThanOrEqual(2);
      // Its own language's screens, not the fallback.
      for (const step of steps) expect(step.src).toContain(`-${locale}-`);
      for (let i = 1; i <= steps.length; i += 1) {
        expect(captions[key]?.[`s${i}`], `${key}.s${i}`).toBeTruthy();
      }
      expect(captions[key]?.[`s${steps.length + 1}`], `${key} has a caption with no screen`).toBe(
        undefined,
      );
    });

    it.each([...RECORDING_KEYS])(
      '%s: every picture is on disk and every box lands on it',
      (key) => {
        const recording = recordingFor(key, locale);
        if (!recording) throw new Error(`no ${key} recording`);
        if (recording.bar) expect(existsSync(path.join(PUBLIC, recording.bar.src))).toBe(true);
        for (const step of recording.steps) {
          expect(existsSync(path.join(PUBLIC, step.src)), step.src).toBe(true);
          expect(step.w).toBe(PHONE_WIDTH);
          for (const action of step.actions as RecAction[]) {
            if (action.type === 'scroll') {
              expect(action.to).toBeGreaterThanOrEqual(0);
              expect(action.to).toBeLessThanOrEqual(step.h);
              continue;
            }
            const surface = action.type === 'tap' && action.on === 'bar' ? recording.bar : step;
            expect(surface, `${step.src}: a bar tap needs a bar`).toBeTruthy();
            expect(action.x).toBeGreaterThanOrEqual(-1);
            expect(action.y).toBeGreaterThanOrEqual(-1);
            expect(action.x + action.w).toBeLessThanOrEqual(PHONE_WIDTH + 1);
            expect(action.y + action.h).toBeLessThanOrEqual((surface?.h ?? 0) + 1);
          }
        }
      },
    );

    it('stays light: no picture over 250 KB, under 2 MB a language', () => {
      let total = 0;
      for (const key of RECORDING_KEYS) {
        const recording = recordingFor(key, locale);
        for (const src of [recording?.bar?.src, ...(recording?.steps ?? []).map((s) => s.src)]) {
          if (!src) continue;
          const bytes = size(src);
          expect(bytes, src).toBeLessThanOrEqual(250 * 1024);
          total += bytes;
        }
      }
      expect(total).toBeLessThanOrEqual(2 * 1024 * 1024);
    });
  },
);
