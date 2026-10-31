'use client';

import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { useRef } from 'react';

import { gsap, MOTION_OK, useGSAP } from '@/components/motion/gsap';
import {
  DIVISION_PROMOTE as PROMOTE,
  DIVISION_RELEGATE as RELEGATE,
  DIVISION_SIZE as SIZE,
} from '@sportkarta/lib/divisions';

export interface DivisionTierLabel {
  name: string;
  peak: string;
  /** "2191 м", formatted. */
  height: string;
  /** Metres, for the drawing. */
  metres: number;
}

export interface DivisionLabels {
  title: string;
  lead: string;
  rules: string[];
  order: string;
  ladder: string;
  group: string;
  up: string;
  stay: string;
  down: string;
}

/** The drawing's floor: a schematic profile, so the peaks read apart. */
const FLOOR = 1500;
const W = 600;
const H = 210;

/**
 * «Седмични дивизии»: the five tiers as the five mountains they are named
 * after, drawn to their real summits over a common floor (Голям Перелик 2191
 * m to Мусала 2925 m — lib/src/divisions), with a climber stepping up from
 * the first; and a group of thirty with the top seven climbing and the bottom
 * five going down (DIVISION_SIZE, DIVISION_PROMOTE, DIVISION_RELEGATE). Words
 * carry everything the drawing shows.
 */
export function DivisionLadder({
  tiers,
  labels,
}: {
  tiers: DivisionTierLabel[];
  labels: DivisionLabels;
}) {
  const root = useRef<HTMLDivElement>(null);
  const top = Math.max(...tiers.map((t) => t.metres));
  const step = W / tiers.length;
  const peaks = tiers.map((tier, i) => {
    const x = step * i + step / 2;
    const y = H - ((tier.metres - FLOOR) / (top - FLOOR)) * (H - 36);
    return { x, y };
  });

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const scope = root.current;
        if (!scope) return;
        const tl = gsap.timeline({
          scrollTrigger: { trigger: scope, start: 'top 75%', once: true },
        });
        tl.from(scope.querySelectorAll('[data-mountain]'), {
          yPercent: 30,
          autoAlpha: 0,
          duration: 0.6,
          ease: 'power3.out',
          stagger: 0.1,
        })
          .from(
            scope.querySelectorAll('[data-flag]'),
            { scale: 0, transformOrigin: '50% 100%', duration: 0.3, stagger: 0.08 },
            '-=0.3',
          )
          .from(scope.querySelectorAll('[data-dot]'), {
            scale: 0,
            duration: 0.25,
            ease: 'back.out(3)',
            stagger: { each: 0.025 },
          });
        const climber = scope.querySelector('[data-climber]');
        const [first, second] = peaks;
        if (climber && first && second) {
          // One climb from the first summit to the second, then it stays —
          // under five seconds, so nothing loops beside the rules (WCAG 2.2.2).
          gsap
            .timeline({
              delay: 1.2,
              scrollTrigger: { trigger: scope, start: 'top 75%', once: true },
            })
            .to(climber, {
              x: (first.x + second.x) / 2,
              y: H - 30,
              duration: 0.8,
              ease: 'power1.inOut',
            })
            .to(climber, { x: second.x, y: second.y - 18, duration: 0.9, ease: 'power2.out' })
            .to(climber, { scale: 1.25, duration: 0.15, yoyo: true, repeat: 1 });
        }
      });
    },
    { scope: root },
  );

  const zone = (i: number) => (i < PROMOTE ? 'up' : i >= SIZE - RELEGATE ? 'down' : 'stay');

  return (
    <div ref={root} className="rounded-card border border-line bg-surface p-5 shadow-xs sm:p-7">
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0">
          <h3 className="text-h3 font-extrabold tracking-tight text-ink">{labels.title}</h3>
          <p className="mt-2 text-body text-ink-soft">{labels.lead}</p>

          <div role="img" aria-label={labels.ladder} className="mt-6">
            <svg viewBox={`0 0 ${W} ${H + 4}`} className="w-full" aria-hidden="true">
              {peaks.map(({ x, y }, i) => (
                <g key={i} data-mountain="">
                  <path
                    d={`M${x - step * 0.62} ${H}L${x - 14} ${y + 12}L${x} ${y}L${x + 12} ${y + 10}L${x + step * 0.62} ${H}Z`}
                    className="text-brand"
                    fill="currentColor"
                    fillOpacity={0.16 + i * 0.13}
                    stroke="currentColor"
                    strokeOpacity="0.5"
                    strokeWidth="1.5"
                  />
                  <path
                    d={`M${x - 9} ${y + 8}L${x} ${y}L${x + 8} ${y + 7}L${x + 3} ${y + 11}L${x - 3} ${y + 9}Z`}
                    className="text-paper"
                    fill="currentColor"
                  />
                  <g data-flag="" className="text-accent">
                    <path d={`M${x} ${y}V${y - 22}`} stroke="currentColor" strokeWidth="2" />
                    <path d={`M${x} ${y - 22}l12 4-12 4z`} fill="currentColor" />
                  </g>
                </g>
              ))}
              <path
                d={`M0 ${H}H${W}`}
                className="text-line-strong"
                stroke="currentColor"
                strokeWidth="2"
              />
              <g
                data-climber=""
                className="text-accent-active"
                // On the first summit until (and unless) the film moves it.
                transform={`translate(${peaks[0]?.x ?? 0} ${(peaks[0]?.y ?? 0) - 18})`}
              >
                <circle r="9" fill="currentColor" />
                <circle
                  r="9"
                  fill="none"
                  className="text-paper"
                  stroke="currentColor"
                  strokeWidth="2.5"
                />
              </g>
            </svg>
            <ol aria-hidden="true" className="mt-2 grid grid-cols-5 gap-1 text-center">
              {tiers.map((tier) => (
                <li key={tier.name} className="min-w-0">
                  <span className="block truncate text-body-sm font-extrabold text-ink">
                    {tier.name}
                  </span>
                  <span className="block truncate text-caption text-ink-soft">{tier.peak}</span>
                  <span className="block font-mono text-caption text-text-muted">
                    {tier.height}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <p className="mt-4 text-caption text-text-muted">{labels.order}</p>
        </div>

        <div className="min-w-0">
          <div role="img" aria-label={labels.group} className="rounded-lg bg-paper p-4">
            <ol aria-hidden="true" className="grid grid-cols-10 gap-1.5">
              {Array.from({ length: SIZE }, (_, i) => {
                const z = zone(i);
                return (
                  <li
                    key={i}
                    data-dot=""
                    className={
                      z === 'up'
                        ? 'grid aspect-square place-items-center rounded-full bg-brand text-on-brand'
                        : z === 'down'
                          ? 'grid aspect-square place-items-center rounded-full bg-accent text-on-accent'
                          : 'aspect-square rounded-full bg-line-strong'
                    }
                  >
                    {z === 'up' && <ArrowUp size={11} strokeWidth={3} />}
                    {z === 'down' && <ArrowDown size={11} strokeWidth={3} />}
                  </li>
                );
              })}
            </ol>
            <ul
              aria-hidden="true"
              className="mt-3 flex flex-wrap justify-between gap-2 font-mono text-caption"
            >
              <li className="flex items-center gap-1 text-brand-active">
                <ArrowUp size={13} /> {PROMOTE} {labels.up}
              </li>
              <li className="flex items-center gap-1 text-ink-soft">
                <Minus size={13} /> {SIZE - PROMOTE - RELEGATE} {labels.stay}
              </li>
              <li className="flex items-center gap-1 text-accent-active">
                <ArrowDown size={13} /> {RELEGATE} {labels.down}
              </li>
            </ul>
          </div>
          <ul className="mt-5 flex flex-col gap-2.5">
            {labels.rules.map((rule) => (
              <li key={rule} className="flex gap-2 text-body-sm text-ink-soft">
                <span
                  aria-hidden="true"
                  className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
                />
                {rule}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
