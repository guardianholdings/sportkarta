import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** The guide's chapter ids — the page's anchors, in reading order. */
export const GUIDE_CHAPTERS = [
  { id: 'namerete', key: 'find' },
  { id: 'dopalnete', key: 'contribute' },
  { id: 'trenirayte', key: 'play' },
  { id: 'pasport', key: 'passport' },
  { id: 'klasirane', key: 'ranking' },
] as const;

export type GuideChapterKey = (typeof GUIDE_CHAPTERS)[number]['key'];

/**
 * One chapter of the front page's guide: the dotted shirt number, the
 * heading, and the chapter's own recording and pictures under it. Chapters
 * alternate between the paper and a raised surface so the long page reads as
 * stops on a route rather than one scroll.
 */
export function Chapter({
  id,
  number,
  overline,
  title,
  lead,
  raised = false,
  children,
}: {
  id: string;
  number: number;
  overline: string;
  title: string;
  lead: string;
  raised?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn('scroll-mt-14', raised && 'border-y border-line bg-surface')}
    >
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-8">
          <span aria-hidden="true" className="sk-chapter-num">
            {String(number).padStart(2, '0')}
          </span>
          <div className="max-w-2xl">
            <p className="sk-overline">{overline}</p>
            <h2
              id={`${id}-title`}
              className="mt-3 text-h2 font-extrabold leading-tight tracking-tight text-ink sm:text-h1"
            >
              {title}
            </h2>
            <p className="mt-3 text-body-lg text-ink-soft">{lead}</p>
          </div>
        </header>
        <div className="mt-10 lg:mt-14">{children}</div>
      </div>
    </section>
  );
}

/** A small titled card the chapters' pictures and notes sit in. */
export function GuideCard({
  title,
  icon,
  children,
  className,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('rounded-card border border-line bg-surface p-5 shadow-xs sm:p-6', className)}
    >
      <h3 className="flex items-center gap-2.5 text-h4 font-extrabold tracking-tight text-ink">
        {icon && (
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent-active">
            {icon}
          </span>
        )}
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}
