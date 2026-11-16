import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A section's heading on the marketing pages: the title, a lead. No label
 * above it — the title names the section, and a second line saying so in
 * small capitals only delayed it.
 */
export function SectionHead({
  id,
  title,
  lead,
  tone = 'light',
  children,
}: {
  id: string;
  title: string;
  lead?: string;
  tone?: 'light' | 'dark';
  /** Links aligned to the heading's baseline on wide screens. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="max-w-2xl">
        <h2
          id={id}
          className={cn(
            'text-h2 font-extrabold leading-tight tracking-tight sm:text-h1',
            tone === 'dark' ? 'text-paper' : 'text-ink',
          )}
        >
          {title}
        </h2>
        {lead && (
          <p className={cn('mt-3 text-body', tone === 'dark' ? 'text-paper/75' : 'text-ink-soft')}>
            {lead}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
