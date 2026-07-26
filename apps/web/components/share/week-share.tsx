'use client';

import { Check, Copy, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';

/**
 * Share your week as pasteable text (C3).
 *
 * A CLIENT component for exactly one reason: only the browser has
 * `navigator.share` and the clipboard. The TEXT is composed on the server and
 * arrives as a prop, so nothing about the member is computed here and no lib
 * subpath is imported into the browser bundle.
 *
 * THREE TIERS, resolved at click time, because support varies wildly across the
 * clients this is meant for:
 *   1. `navigator.share` — the native sheet, which on Android hands straight to
 *      Viber. Text only: no files, no URL object, no SDK.
 *   2. `navigator.clipboard` — copy, and say so.
 *   3. Neither — the text is already on the page, selectable. Nothing is
 *      disabled and nothing is hidden.
 *
 * NEVER DISABLED. A disabled share button is a dead control, and
 * DEAD-CONTROLS.md has a standing rule against orphan-disabled buttons. If both
 * APIs are missing the member can still select the text with their thumb.
 *
 * The trigger is LABELLED, not a bare icon: the UX audit's cross-cutting P1 is
 * discoverability, and an unlabelled icon is the least discoverable control
 * there is.
 */
export function WeekShare({ text }: { text: string }) {
  const t = useTranslations('Share');
  const [copied, setCopied] = useState(false);

  async function onShare(): Promise<void> {
    // Read both capabilities off one reference before branching: narrowing
    // `navigator` with `in` collapses it to `never` on the second check, and the
    // resulting error is opaque enough to invite an `any`.
    const nav: Navigator | null = typeof navigator === 'undefined' ? null : navigator;
    const canShare = typeof nav?.share === 'function';
    const canCopy = typeof nav?.clipboard?.writeText === 'function';

    try {
      if (nav && canShare) {
        await nav.share({ text });
        return;
      }
      if (nav && canCopy) {
        await nav.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 2400);
      }
    } catch {
      // A cancelled share sheet rejects, and that is not an error the member
      // needs told about. The text stays on screen either way.
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
      <h2 className="text-h4 font-bold text-ink">{t('weekTitle')}</h2>
      <p className="mt-1 text-body-sm text-ink-soft">{t('weekBody')}</p>

      {/* Readable and selectable, so tier 3 is a real fallback rather than a
          dead end. Mono so the grid does not reflow between glyph widths. */}
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md border border-line-strong bg-paper-sunk px-3 py-2 font-mono text-body-sm text-ink">
        {text}
      </pre>

      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void onShare();
          }}
          iconLeft={copied ? <Check size={20} /> : <Share2 size={20} />}
          data-umami-event={ANALYTICS_EVENTS.weekShare}
        >
          {copied ? t('copied') : t('share')}
        </Button>
        {/* A label swap alone is not announced by every screen reader. */}
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? t('copied') : ''}
        </span>
        <span className="text-caption text-text-muted">
          <Copy size={13} className="mr-1 inline" />
          {t('copy')}
        </span>
      </div>
    </section>
  );
}
