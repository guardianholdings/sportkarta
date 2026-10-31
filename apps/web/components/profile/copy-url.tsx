'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * A URL to paste somewhere else, with a «Копирай» beside it (UX audit: the
 * calendar feed had to be selected by thumb). The week share's fallback: with
 * no clipboard API the press selects the text for the OS's own copy, so the
 * button is never a dead control. Strings arrive resolved — this reads no
 * message namespace in the browser.
 *
 * The button keeps one name; «Копирано» is said by a status region beside it,
 * so a screen reader hears the result without the control being renamed.
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
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function select(): void {
    if (textRef.current) window.getSelection()?.selectAllChildren(textRef.current);
  }

  async function copy(): Promise<void> {
    const nav: Navigator | null = typeof navigator === 'undefined' ? null : navigator;
    if (typeof nav?.clipboard?.writeText !== 'function') {
      select();
      return;
    }
    try {
      await nav.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2400);
    } catch {
      select();
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
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void copy()}
          iconLeft={copied ? <Check size={16} /> : <Copy size={16} />}
        >
          {labels.copy}
        </Button>
        <span role="status" className="text-caption text-text-muted">
          {copied ? labels.copied : ''}
        </span>
      </div>
    </div>
  );
}
