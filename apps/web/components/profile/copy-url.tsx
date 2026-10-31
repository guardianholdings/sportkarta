'use client';

import { Check, Copy } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * A URL to paste somewhere else, with a «Копирай» beside it (UX audit: the
 * calendar feed had to be selected by thumb). The week share's fallback: with
 * no clipboard API the press selects the text for the OS's own copy, so the
 * button is never a dead control. Strings arrive resolved — this reads no
 * message namespace in the browser.
 */
export function CopyUrl({
  value,
  labels,
}: {
  value: string;
  labels: { copy: string; copied: string };
}) {
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  async function copy(): Promise<void> {
    const nav: Navigator | null = typeof navigator === 'undefined' ? null : navigator;
    if (typeof nav?.clipboard?.writeText !== 'function') {
      if (textRef.current) window.getSelection()?.selectAllChildren(textRef.current);
      return;
    }
    try {
      await nav.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2400);
    } catch {
      if (textRef.current) window.getSelection()?.selectAllChildren(textRef.current);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Selectable text rather than a link: clicking it would open the
          download, and what the member needs is to paste it into a calendar
          app's "subscribe by URL" box. */}
      <p
        ref={textRef}
        className="overflow-x-auto rounded-md border border-line bg-paper-sunk p-2.5 font-mono text-caption"
      >
        {value}
      </p>
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void copy()}
          iconLeft={copied ? <Check size={16} /> : <Copy size={16} />}
        >
          <span aria-live="polite">{copied ? labels.copied : labels.copy}</span>
        </Button>
      </div>
    </div>
  );
}
