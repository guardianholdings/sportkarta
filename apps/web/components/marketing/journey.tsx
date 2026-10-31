'use client';

import { ArrowRight } from 'lucide-react';
import { useRef } from 'react';

import { gsap, MOTION_OK, useGSAP } from '@/components/motion/gsap';
import { Link } from '@/i18n/navigation';

export interface JourneyStep {
  key: 'find' | 'join' | 'collect';
  href: '/karta' | '/sesii' | '/pasport';
  title: string;
  body: string;
}

/** An eleven-by-eleven code: three finder squares and a scatter, nothing real. */
const QR = [
  '11111110101',
  '10000010010',
  '10111010110',
  '10111010011',
  '10111011101',
  '10000010010',
  '11111110101',
  '00000000110',
  '10110111001',
  '01001010111',
  '11011101010',
];

/** The map a pin drops on: a seven-by-four field of faint dots. */
function FindVignette() {
  return (
    <svg viewBox="0 0 240 140" className="h-full w-full" aria-hidden="true">
      <g className="text-brand" fill="currentColor" opacity="0.35">
        {Array.from({ length: 4 }, (_, row) =>
          Array.from({ length: 7 }, (_, col) => (
            <circle key={`${row}-${col}`} cx={30 + col * 30} cy={30 + row * 28} r="3" />
          )),
        )}
      </g>
      <circle
        className="sk-vg-ripple text-accent"
        cx="120"
        cy="86"
        r="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0"
      />
      <g className="sk-vg-pin text-accent" fill="currentColor">
        <path d="M120 44c-13 0-22 9-22 21 0 16 22 36 22 36s22-20 22-36c0-12-9-21-22-21z" />
        <circle cx="120" cy="65" r="8" className="text-paper" fill="currentColor" />
      </g>
    </svg>
  );
}

/** The code at the door: a pattern that assembles, a scan, a tick. */
function JoinVignette() {
  const cell = 6;
  const size = QR.length * cell;
  const left = 120 - size / 2;
  const top = 62 - size / 2;
  return (
    <svg viewBox="0 0 240 140" className="h-full w-full" aria-hidden="true">
      <rect
        x={left - 10}
        y={top - 10}
        width={7 * cell + 20}
        height={7 * cell + 20}
        rx="8"
        className="text-surface"
        fill="currentColor"
      />
      <g className="sk-vg-qr text-ink" fill="currentColor">
        {QR.flatMap((row, r) =>
          [...row].map((bit, c) =>
            bit === '1' ? (
              <rect
                key={`${r}-${c}`}
                className="sk-vg-cell"
                x={left + c * cell}
                y={top + r * cell}
                width={cell - 1}
                height={cell - 1}
                style={{
                  transformOrigin: `${left + c * cell + cell / 2}px ${top + r * cell + cell / 2}px`,
                }}
              />
            ) : null,
          ),
        )}
      </g>
      <rect
        className="sk-vg-scan text-accent"
        x={left - 10}
        y={top - 10}
        width={7 * cell + 20}
        height="3"
        fill="currentColor"
        opacity="0"
      />
      <g className="sk-vg-check text-brand" style={{ transformOrigin: '186px 104px' }}>
        <circle cx="186" cy="104" r="16" fill="currentColor" />
        <path
          d="M177 104l6 6 12-12"
          fill="none"
          className="text-paper"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/** Three coins flip into the passport and the points tick up. */
function CollectVignette() {
  return (
    <svg viewBox="0 0 240 140" className="h-full w-full" aria-hidden="true">
      {[64, 120, 176].map((cx, index) => (
        <g key={cx} className="sk-vg-coin" style={{ transformOrigin: `${cx}px 62px` }}>
          <circle
            cx={cx}
            cy="62"
            r="24"
            className={index === 1 ? 'text-accent' : 'text-brand'}
            fill="currentColor"
            opacity="0.15"
          />
          <circle
            cx={cx}
            cy="62"
            r="24"
            className={index === 1 ? 'text-accent' : 'text-brand'}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeDasharray="4 3"
          />
          <circle
            cx={cx}
            cy="62"
            r="9"
            className={index === 1 ? 'text-accent' : 'text-brand'}
            fill="currentColor"
          />
        </g>
      ))}
      <text
        className="sk-vg-points font-mono text-ink"
        x="120"
        y="124"
        textAnchor="middle"
        fill="currentColor"
        fontSize="20"
        fontWeight="700"
      >
        +0
      </text>
    </svg>
  );
}

/**
 * «Как работи» as three small films: a pin dropping onto the map, a QR code
 * assembling and ticking green, three coins flipping while the points count.
 * Each plays once when its card scrolls into view (GSAP + ScrollTrigger),
 * and under reduced motion the server-rendered final frame simply stands.
 * The words arrive as props from the server page — this component reads no
 * catalogue of its own.
 */
export function Journey({ steps, pointsLabel }: { steps: JourneyStep[]; pointsLabel: string }) {
  const ref = useRef<HTMLOListElement>(null);

  useGSAP(
    () => {
      const root = ref.current;
      if (!root) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const card = (key: string) => root.querySelector<HTMLElement>(`[data-step="${key}"]`);
        const once = (trigger: Element | null) => ({
          trigger: trigger ?? root,
          start: 'top 80%',
          once: true,
        });

        // 1. The pin drops, bounces, and the map answers with a ripple.
        const find = card('find');
        if (find) {
          gsap
            .timeline({ scrollTrigger: once(find) })
            .from(find.querySelector('.sk-vg-pin'), {
              y: -70,
              opacity: 0,
              duration: 0.8,
              ease: 'bounce.out',
            })
            .fromTo(
              find.querySelector('.sk-vg-ripple'),
              { scale: 0.4, opacity: 0.9, transformOrigin: '120px 86px' },
              {
                scale: 2.2,
                opacity: 0,
                duration: 1.1,
                ease: 'power2.out',
                repeat: 2,
                repeatDelay: 0.3,
              },
              '-=0.2',
            );
        }

        // 2. The code assembles cell by cell, a line scans it, the tick lands.
        const join = card('join');
        if (join) {
          gsap
            .timeline({ scrollTrigger: once(join) })
            .from(join.querySelectorAll('.sk-vg-cell'), {
              scale: 0,
              duration: 0.4,
              ease: 'back.out(2)',
              stagger: { amount: 0.7, from: 'random' },
            })
            .fromTo(
              join.querySelector('.sk-vg-scan'),
              { y: 0, opacity: 1 },
              { y: 84, duration: 0.9, ease: 'power1.inOut' },
            )
            .to(join.querySelector('.sk-vg-scan'), { opacity: 0, duration: 0.2 })
            .from(
              join.querySelector('.sk-vg-check'),
              { scale: 0, duration: 0.5, ease: 'back.out(2.5)' },
              '-=0.1',
            )
            .from(
              join.querySelector('.sk-vg-check path'),
              { drawSVG: '0%', duration: 0.4 },
              '-=0.2',
            );
        }

        // 3. The coins flip in and the points count up beside them.
        const collect = card('collect');
        if (collect) {
          const points = collect.querySelector<SVGTextElement>('.sk-vg-points');
          const counter = { value: 0 };
          gsap
            .timeline({ scrollTrigger: once(collect) })
            .from(collect.querySelectorAll('.sk-vg-coin'), {
              rotationY: -180,
              opacity: 0,
              duration: 0.7,
              ease: 'power3.out',
              stagger: 0.18,
              transformPerspective: 500,
            })
            .to(
              counter,
              {
                value: 16,
                duration: 1.1,
                ease: 'power1.out',
                snap: { value: 1 },
                onUpdate: () => {
                  if (points) points.textContent = `+${counter.value} ${pointsLabel}`;
                },
              },
              '-=0.3',
            );
        }
      });
    },
    { scope: ref },
  );

  const vignette = { find: FindVignette, join: JoinVignette, collect: CollectVignette } as const;

  return (
    <ol ref={ref} className="grid gap-3 sm:grid-cols-3">
      {steps.map((step, index) => {
        const Vignette = vignette[step.key];
        return (
          <li key={step.key} data-step={step.key} data-reveal>
            <Link
              href={step.href}
              className="group flex h-full flex-col rounded-card border border-line bg-surface transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-md focus-visible:shadow-[var(--ring)]"
            >
              <span className="sk-vignette relative block aspect-[12/7] w-full overflow-hidden rounded-t-card">
                <span
                  aria-hidden="true"
                  className="absolute left-4 top-4 grid size-7 place-items-center rounded-full bg-accent font-mono text-body-sm font-bold text-on-accent"
                >
                  {index + 1}
                </span>
                <Vignette />
              </span>
              <span className="flex flex-1 flex-col gap-1 p-5">
                <span className="flex items-center gap-2 text-body font-bold text-ink group-hover:text-brand">
                  {step.title}
                  <ArrowRight
                    size={18}
                    aria-hidden="true"
                    className="text-text-muted transition-transform duration-150 ease-standard group-hover:translate-x-0.5 group-hover:text-brand"
                  />
                </span>
                <span className="text-body-sm text-ink-soft">{step.body}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
