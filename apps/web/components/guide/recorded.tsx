import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { recordingFor, type RecordingKey } from '@/lib/home/guide-recordings';

import { ScreenRecording, type RecordingTrack } from './screen-recording';

/**
 * A chapter's recording(s) with the chapter's own pictures under the steps.
 * The captions are `Home.guide.recordings.<key>.s1…sN`, one per screen the
 * manifest holds (tests/guide-recordings.test.ts keeps the two in step). A
 * flow with no screens yet leaves just the pictures.
 */
export async function Recorded({
  keys,
  locale,
  note,
  children,
}: {
  keys: RecordingKey[];
  locale: string;
  note?: string;
  children?: ReactNode;
}) {
  const t = await getTranslations('Home.guide');
  const tracks: RecordingTrack[] = keys.flatMap((key) => {
    const recording = recordingFor(key, locale);
    if (!recording || recording.steps.length === 0) return [];
    return [
      {
        key,
        tab: key === 'add' || key === 'verify' ? t(`contribute.tabs.${key}`) : undefined,
        label: t('player.label', { title: t(`recordings.${key}.title`) }),
        recording,
        steps: recording.steps.map((_, i) => ({
          title: t(`recordings.${key}.s${i + 1}.title`),
          body: t(`recordings.${key}.s${i + 1}.body`),
        })),
      },
    ];
  });
  if (tracks.length === 0) return <>{children}</>;

  return (
    <ScreenRecording
      tracks={tracks}
      note={note}
      labels={{
        stepOf: t.raw('player.step') as string,
        steps: t('player.steps'),
        tabs: t('contribute.tabs.label'),
      }}
    >
      {children}
    </ScreenRecording>
  );
}
