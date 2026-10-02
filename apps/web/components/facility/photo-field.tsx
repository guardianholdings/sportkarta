'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';

import {
  downscalePhoto,
  MAX_UPLOAD_PHOTO_BYTES,
  needsDownscaleAttempt,
} from '@/lib/photo-downscale';

/**
 * The shared behaviour of every contribution photo input (add, condition and
 * the anonymous report): shrink a large phone photo in the browser before the
 * form can post it, and refuse — visibly, before submit — one that stays too
 * big. See lib/photo-downscale.ts for why this cannot be left to the server.
 *
 * Each form keeps its own `<input type="file">` markup (the add form wraps it
 * with an icon, the others do not) and wires `onChange` from here.
 *
 * NO `capture` ATTRIBUTE on any of those inputs, deliberately. `capture` makes
 * iOS and Android open the camera directly with no photo-library choice, and
 * the add form's photo is REQUIRED — so a member who photographed a pitch this
 * morning and files it tonight (the honest case lib/contributions/proximity.ts
 * calls very common) could not finish the form on a phone at all. Without it
 * the OS offers the camera AND the library.
 */

export type PhotoStatus = 'idle' | 'processing' | 'tooLarge';

export function usePhotoField(): {
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  status: PhotoStatus;
} {
  const t = useTranslations('Contribute');
  const [status, setStatus] = useState<PhotoStatus>('idle');
  // A member can pick again while the previous photo is still being shrunk;
  // only the newest pick may write to the input.
  const latestPick = useRef(0);

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      const pick = ++latestPick.current;
      input.setCustomValidity('');
      // The common case is decided synchronously, so a small photo never opens
      // a window in which the form refuses to submit.
      if (!file || !needsDownscaleAttempt(file.size)) {
        setStatus('idle');
        return;
      }
      // While the browser works, the form must not post the ORIGINAL — which is
      // exactly the file that would blow the body limit. A custom validity
      // message holds the submit natively, with no coordination with the form.
      input.setCustomValidity(t('photoField.processing'));
      setStatus('processing');
      void downscalePhoto(file).then((result) => {
        if (pick !== latestPick.current) return;
        input.setCustomValidity('');
        const sent = result === file || replaceSelectedFile(input, result) ? result : file;
        if (sent.size > MAX_UPLOAD_PHOTO_BYTES) {
          // Cleared rather than held invalid: on the optional-photo forms the
          // member must still be able to send without it, and a phone offers no
          // way to empty a file input. On the add form `required` then asks for
          // another photo, with the reason shown right under it.
          input.value = '';
          setStatus('tooLarge');
          return;
        }
        setStatus('idle');
      });
    },
    [t],
  );

  return { onChange, status };
}

/** Swap the picked file for the shrunk one. False where DataTransfer is missing. */
function replaceSelectedFile(input: HTMLInputElement, file: File): boolean {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    return true;
  } catch {
    return false;
  }
}

/**
 * Always rendered, empty when idle: a live region has to exist BEFORE its text
 * changes, or screen readers never announce the "too large" verdict.
 */
export function PhotoFieldStatus({ status }: { status: PhotoStatus }) {
  const t = useTranslations('Contribute');
  return (
    <span
      aria-live="polite"
      className={
        status === 'tooLarge'
          ? 'text-caption font-medium text-danger'
          : 'text-caption text-text-muted'
      }
    >
      {status === 'tooLarge' && t('photoField.tooLarge')}
      {status === 'processing' && t('photoField.processing')}
    </span>
  );
}
