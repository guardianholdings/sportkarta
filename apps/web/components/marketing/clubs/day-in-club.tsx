'use client';

import { useRef, useState } from 'react';

import { gsap, MOTION_OK, ScrollTrigger, useGSAP } from '@/components/motion/gsap';
import { cn } from '@/lib/utils';

import { EXPLORER_OPEN_EVENT } from './office-explorer';

export interface DayMoment {
  key: string;
  /** HH:MM, Sofia wall clock. */
  time: string;
  title: string;
  body: string;
  areas: { key: string; label: string }[];
}

function angles(time: string): { hour: number; minute: number } {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return { hour: ((h % 12) + m / 60) * 30, minute: m * 6 };
}

/**
 * «Един ден в клуба» — the office's day as a story: the clock on the left
 * turns to each moment as its card scrolls into the middle of the screen,
 * the card lights up, and its chips open the matching area of the explorer
 * below. Under reduced motion the hands jump instead of sweeping; the story
 * reads the same.
 */
export function DayInClub({ moments, openLabel }: { moments: DayMoment[]; openLabel: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const current = moments[active] ?? moments[0];

  useGSAP(
    () => {
      const scope = root.current;
      if (!scope) return;
      const cards = Array.from(scope.querySelectorAll<HTMLElement>('[data-moment]'));
      cards.forEach((card, index) => {
        ScrollTrigger.create({
          trigger: card,
          start: 'top 60%',
          end: 'bottom 40%',
          onEnter: () => setActive(index),
          onEnterBack: () => setActive(index),
        });
      });
    },
    { scope: root },
  );

  useGSAP(
    () => {
      const scope = root.current;
      if (!scope || !current) return;
      const { hour, minute } = angles(current.time);
      const reduced = !window.matchMedia(MOTION_OK).matches;
      gsap.to(scope.querySelector('[data-hand="hour"]'), {
        rotation: hour,
        duration: reduced ? 0 : 0.9,
        ease: 'power3.inOut',
        transformOrigin: '50% 100%',
      });
      gsap.to(scope.querySelector('[data-hand="minute"]'), {
        rotation: minute,
        duration: reduced ? 0 : 0.9,
        ease: 'power3.inOut',
        transformOrigin: '50% 100%',
      });
    },
    { scope: root, dependencies: [current?.time] },
  );

  return (
    <div ref={root} className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
      <div className="lg:sticky lg:top-24 lg:self-start">
        <div className="flex items-center gap-5 rounded-card border border-line bg-surface p-5">
          <svg viewBox="0 0 100 100" className="size-24 shrink-0 text-ink" aria-hidden="true">
            <circle
              cx="50"
              cy="50"
              r="46"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.15"
            />
            {Array.from({ length: 12 }, (_, i) => (
              <line
                key={i}
                x1="50"
                y1="8"
                x2="50"
                y2={i % 3 === 0 ? '16' : '12'}
                stroke="currentColor"
                strokeWidth={i % 3 === 0 ? 3 : 1.5}
                strokeLinecap="round"
                transform={`rotate(${i * 30} 50 50)`}
                opacity="0.5"
              />
            ))}
            <line
              data-hand="hour"
              x1="50"
              y1="50"
              x2="50"
              y2="28"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <line
              data-hand="minute"
              x1="50"
              y1="50"
              x2="50"
              y2="18"
              className="text-accent"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <circle cx="50" cy="50" r="3.5" fill="currentColor" />
          </svg>
          <div className="min-w-0" aria-live="polite">
            <p className="font-mono text-display-lg font-bold tabular-nums leading-none text-ink">
              {current?.time}
            </p>
            <p className="mt-2 text-body font-bold text-ink">{current?.title}</p>
          </div>
        </div>
      </div>
      <ol className="flex flex-col gap-3">
        {moments.map((moment, index) => (
          <li
            key={moment.key}
            data-moment
            className={cn(
              'rounded-card border p-5 transition-[border-color,background-color,box-shadow] duration-300 ease-standard',
              index === active
                ? 'border-accent-border bg-surface shadow-md'
                : 'border-line bg-paper',
            )}
          >
            <p className="flex items-center gap-3">
              <span className="font-mono text-body-sm font-bold tabular-nums text-accent-active">
                {moment.time}
              </span>
              <span className="text-body font-bold text-ink">{moment.title}</span>
            </p>
            <p className="mt-2 text-body-sm text-ink-soft">{moment.body}</p>
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={openLabel}>
              {moment.areas.map((area) => (
                <li key={area.key}>
                  <a
                    href="#funktsii"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent(EXPLORER_OPEN_EVENT, { detail: area.key }),
                      )
                    }
                    className="inline-flex min-h-8 items-center rounded-pill border border-line bg-surface px-2.5 text-caption font-semibold text-ink-soft hover:border-brand-border hover:text-brand"
                  >
                    {area.label}
                  </a>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
