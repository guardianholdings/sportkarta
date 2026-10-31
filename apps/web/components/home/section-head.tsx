import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** The front page's section heading: a coral-ruled overline, the title, a lead. */
export function SectionHead({
  id,
  overline,
  title,
  lead,
  tone = 'light',
  children,
}: {
  id: string;
  overline: string;
  title: string;
  lead?: string;
  tone?: 'light' | 'dark';
  /** Links aligned to the heading's baseline on wide screens. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="max-w-2xl">
        <p className={cn('sk-overline', tone === 'dark' && 'sk-overline--dark')}>{overline}</p>
        <h2
          id={id}
          className={cn(
            'mt-3 text-h2 font-extrabold leading-tight tracking-tight sm:text-h1',
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
