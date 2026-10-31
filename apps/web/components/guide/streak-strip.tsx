'use client';

import { Check, Flame, Snowflake } from 'lucide-react';
import { useRef } from 'react';

import { gsap, MOTION_OK, useGSAP } from '@/components/motion/gsap';
import { cn } from '@/lib/utils';

export interface StreakLabels {
  title: string;
  days: { title: string; body: string };
  weeks: { title: string; body: string };
  freeze: { title: string; body: string };
  clock: string;
  stripLabel: string;
  trained: string;
  frozen: string;
}

/** Eight weeks, the fifth one missed and kept (STREAK_FREEZE_CAP_PER_YEAR is 2). */
const WEEKS = ['on', 'on', 'on', 'on', 'kept', 'on', 'on', 'on'] as const;

/**
 * «Две серии»: days and weeks, and the freeze that keeps a week streak
 * through a missed week, up to twice a year (lib/src/badges/streaks.ts). The
 * strip fills week by week; the kept week turns over to a snowflake and the
 * line runs on through it. Under reduced motion it is simply drawn.
 */
export function StreakStrip({ labels }: { labels: StreakLabels }) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const weeks = gsap.utils.toArray<HTMLElement>('[data-week]', root.current);
        const line = root.current?.querySelector('[data-line]');
        const tl = gsap.timeline({
          scrollTrigger: { trigger: root.current, start: 'top 80%', once: true },
        });
        tl.from(line ?? [], { scaleX: 0, transformOrigin: 'left', duration: 2, ease: 'none' }, 0);
        weeks.forEach((week, i) => {
          const kept = week.dataset.week === 'kept';
          tl.from(
            week,
            kept
              ? { rotationY: 180, autoAlpha: 0, duration: 0.5, ease: 'back.out(1.6)' }
              : { scale: 0, duration: 0.35, ease: 'back.out(2.4)' },
            i * 0.25,
          );
        });
      });
    },
    { scope: root },
  );

  return (
    <div ref={root} className="rounded-card border border-line bg-surface p-5 shadow-xs sm:p-6">
      <h3 className="flex items-center gap-2.5 text-h4 font-extrabold tracking-tight text-ink">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent-active">
          <Flame size={18} aria-hidden="true" />
        </span>
        {labels.title}
      </h3>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[labels.days, labels.weeks].map((streak) => (
          <div key={streak.title} className="rounded-lg bg-paper p-3.5">
            <dt className="text-body-sm font-bold text-ink">{streak.title}</dt>
            <dd className="mt-1 text-caption text-ink-soft">{streak.body}</dd>
          </div>
        ))}
      </dl>

      <div role="img" aria-label={labels.stripLabel} className="relative mt-5 px-1">
        <span
          data-line=""
          aria-hidden="true"
          className="absolute inset-x-4 top-1/2 h-1 -translate-y-1/2 rounded-pill bg-brand-subtle"
        />
        <ol aria-hidden="true" className="relative grid grid-cols-8 gap-1.5">
          {WEEKS.map((state, i) => (
            <li
              key={i}
              data-week={state}
              className={cn(
                'grid aspect-square place-items-center rounded-md border-2',
                state === 'kept'
                  ? 'border-sky-500 bg-sky-100 text-sky-700'
                  : 'border-brand bg-brand text-on-brand',
              )}
            >
              {state === 'kept' ? <Snowflake size={16} /> : <Check size={16} />}
            </li>
          ))}
        </ol>
      </div>
      <ul
        aria-hidden="true"
        className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-soft"
      >
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-brand" />
          {labels.trained}
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-sky-500" />
          {labels.frozen}
        </li>
      </ul>
      <p className="mt-4 text-body-sm text-ink-soft">
        <span className="font-bold text-ink">{labels.freeze.title}.</span> {labels.freeze.body}
      </p>
      <p className="mt-2 text-caption text-text-muted">{labels.clock}</p>
    </div>
  );
}
