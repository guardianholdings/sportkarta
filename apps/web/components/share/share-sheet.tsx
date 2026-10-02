'use client';

import type { SharePayload, ShareNetwork } from '@sportkarta/lib/share';
import { carriesCaption, NETWORKS, networkUrl } from '@sportkarta/lib/share';
import { Check, Download, Image as ImageIcon, Link2, Share2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';

import { attemptShare } from './share-flow';

/**
 * The share affordance, on every surface worth sharing.
 *
 * ONE COMPONENT FOR NINE MOMENTS, because the differences between them are DATA
 * (`SharePayload`) rather than behaviour. A per-surface share button is how nine
 * slightly different share flows drift apart until only one of them works.
 *
 * THE ORDER OF ATTEMPTS IS THE WHOLE DESIGN, and it is built around one platform
 * fact: **Instagram and Facebook Stories have no web share intent.** No URL opens
 * a story composer. The only two ways to reach them are the OS share sheet with
 * a FILE attached, and saving the image to post by hand. So:
 *
 *   1. `navigator.share({ files })` — fetch the story PNG, hand it to the OS,
 *      with the link in the caption. This is the one path that reaches
 *      Instagram Stories, Facebook Stories and Viber in a single tap, and it is
 *      why the story image exists at all. Tried first whenever the payload has
 *      a story and the browser admits it can take files.
 *   2. `navigator.share({ text, url })` — the text sheet. Reaches Viber and
 *      Messenger on every mobile browser that has it.
 *   3. The panel below — copy, download, and plain per-network links. Also
 *      where a share that FAILED lands (share-flow.ts): only the member's own
 *      cancel stays silent.
 *
 * A DISCLOSURE, NOT A MODAL. This app has no dialog primitive and does not need
 * one for a URL and five anchors.
 *
 * NO SDK, NO PIXEL, NO IFRAME — and that is not minimalism. A third-party share
 * SDK sets cookies, which would require a consent banner and break the
 * cookieless architecture the whole site is built on (docs/ENGAGEMENT.md §3).
 * Every target here is a plain anchor.
 *
 * NEVER DISABLED. `DEAD-CONTROLS.md` has a standing rule against
 * orphan-disabled buttons: if every API is missing, the panel still shows a
 * selectable URL. The trigger is LABELLED rather than a bare icon — the UX
 * audit's cross-cutting P1 is discoverability.
 */

export interface ShareSheetStrings {
  /** The button label. Varies by surface: "Сподели тренировката", "…успеха". */
  trigger: string;
  panelTitle: string;
  copyLink: string;
  copyText: string;
  copied: string;
  downloadStory: string;
  storyHint: string;
  facebookNote: string;
  networks: Record<ShareNetwork, string>;
}

export function ShareSheet({
  payload,
  strings,
  variant = 'secondary',
  size = 'md',
}: {
  payload: SharePayload;
  strings: ShareSheetStrings;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'link' | 'text' | null>(null);
  /** The story fetch, started as early as the member reaches for the button. */
  const storyRef = useRef<Promise<File | null> | null>(null);

  const note = (what: 'link' | 'text') => {
    setCopied(what);
    window.setTimeout(() => {
      setCopied(null);
    }, 2400);
  };

  /**
   * Fetch the story image as a File so the OS sheet can offer Instagram and
   * Facebook Stories. Returns null on any failure — a story is an enhancement,
   * and a share must never fail because an image did.
   */
  async function storyFile(): Promise<File | null> {
    if (!payload.storyPath) return null;
    try {
      // Same-origin and credentialed: the person-scoped routes are session
      // gated, so a default `omit` would silently 404 every personal story.
      const response = await fetch(payload.storyPath, { credentials: 'same-origin' });
      if (!response.ok) return null;
      const blob = await response.blob();
      return new File([blob], `pops-${payload.kind}.png`, { type: 'image/png' });
    } catch {
      return null;
    }
  }

  /**
   * One fetch per sheet, begun on pointer-down rather than on click: the
   * OS share has to start inside the tap's user activation, and every
   * millisecond the image takes comes out of that window. A later tap reuses
   * whatever the first one fetched.
   */
  function prefetchStory(): Promise<File | null> {
    storyRef.current ??= storyFile();
    return storyRef.current;
  }

  async function onShare(): Promise<void> {
    const nav: Navigator | null = typeof navigator === 'undefined' ? null : navigator;
    const outcome = await attemptShare(nav, payload, prefetchStory);
    if (outcome === 'panel') setOpen(true);
  }

  async function copy(value: string, what: 'link' | 'text'): Promise<void> {
    const nav: Navigator | null = typeof navigator === 'undefined' ? null : navigator;
    if (typeof nav?.clipboard?.writeText !== 'function') return;
    try {
      await nav.clipboard.writeText(value);
      note(what);
    } catch {
      /* Clipboard denied. The value is on screen and selectable. */
    }
  }

  const field =
    'w-full overflow-x-auto rounded-md border border-line-strong bg-paper-sunk px-3 py-2 font-mono text-caption text-ink';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={variant}
          size={size}
          onPointerDown={() => {
            if (payload.storyPath) void prefetchStory();
          }}
          onClick={() => {
            void onShare();
          }}
          iconLeft={<Share2 size={20} />}
          data-umami-event={ANALYTICS_EVENTS.shareOpen}
        >
          {strings.trigger}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size={size}
          onClick={() => {
            setOpen((value) => !value);
          }}
          aria-expanded={open}
          iconLeft={<Link2 size={18} />}
        >
          {strings.panelTitle}
        </Button>
      </div>

      {open && (
        <div className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
          {/* The story image, offered as a download for every desktop browser
              and every mobile one whose share sheet refuses files. This is the
              universal path to Instagram: save, then post. */}
          {payload.storyPath && (
            <div className="space-y-1">
              <a
                href={payload.storyPath}
                download={`pops-${payload.kind}.png`}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-line-strong px-4 py-1.5 text-body-sm font-medium text-ink hover:bg-paper-sunk"
                data-umami-event={ANALYTICS_EVENTS.shareDownload}
              >
                <Download size={16} />
                {strings.downloadStory}
              </a>
              <p className="flex items-center gap-1.5 text-caption text-text-muted">
                <ImageIcon size={13} />
                {strings.storyHint}
              </p>
            </div>
          )}

          <div className="space-y-1">
            <p className={field}>{payload.url}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void copy(payload.url, 'link');
                }}
                iconLeft={copied === 'link' ? <Check size={16} /> : <Link2 size={16} />}
              >
                {copied === 'link' ? strings.copied : strings.copyLink}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void copy(`${payload.text}\n${payload.url}`, 'text');
                }}
                iconLeft={copied === 'text' ? <Check size={16} /> : <Share2 size={16} />}
              >
                {copied === 'text' ? strings.copied : strings.copyText}
              </Button>
            </div>
          </div>

          {/* Plain anchors, Viber and Facebook first — the country's order
              (ENGAGEMENT §1.1), not the world's. */}
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {NETWORKS.map((network) => (
              <a
                key={network}
                href={networkUrl(network, payload.text, payload.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-pill border border-line-strong px-3 py-1.5 text-body-sm font-medium text-ink hover:bg-paper-sunk"
                data-umami-event={ANALYTICS_EVENTS.shareNetwork}
              >
                {strings.networks[network]}
              </a>
            ))}
          </div>

          {/* Said out loud rather than hidden: Facebook has ignored a `quote`
              parameter since 2017, so the caption does not travel with a
              sharer.php link. A share that silently loses its words reads as
              the product's bug. */}
          <p className="text-caption text-text-muted">{strings.facebookNote}</p>

          <span role="status" aria-live="polite" className="sr-only">
            {copied ? strings.copied : ''}
          </span>
        </div>
      )}
    </div>
  );
}

/** Networks whose caption survives — exported so a caller can explain the gap. */
export function captionCarryingNetworks(): ShareNetwork[] {
  return NETWORKS.filter((network) => carriesCaption(network));
}
