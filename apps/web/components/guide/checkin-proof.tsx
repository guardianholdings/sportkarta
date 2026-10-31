'use client';

import { Clock, MapPin, QrCode } from 'lucide-react';
import { useRef } from 'react';

import { gsap, MOTION_OK, useGSAP } from '@/components/motion/gsap';

export interface CheckinProofLabels {
  title: string;
  rotate: { title: string; body: string };
  place: { title: string; body: string };
  time: { title: string; body: string };
  result: string;
  without: string;
  ticks: { before: string; start: string; end: string; after: string };
  /** "60 с", already formatted. */
  seconds: string;
  /** "+2", the points a check-in earns, already formatted. */
  points: string;
}

const SIZE = 9;

/** A deterministic scatter for one code face — the same on server and client. */
function face(seed: number): boolean[] {
  let state = seed * 9301 + 49297;
  const next = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  return Array.from({ length: SIZE * SIZE }, (_, i) => {
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    // The three finder corners stay put; only the data cells change.
    const inFinder = (r < 3 && c < 3) || (r < 3 && c > SIZE - 4) || (r > SIZE - 4 && c < 3);
    return inFinder ? true : next() > 0.52;
  });
}

const FACES = [face(1), face(2), face(3)];
/** One face's turn: three turns play once, inside five seconds (WCAG 2.2.2). */
const CYCLE = 1.1;

/**
 * «Как QR кодът показва, че сте били там»: the code that changes every minute
 * (shown sped up, three faces turning over while a ring runs out), the
 * 250-metre circle, and the check-in window from half an hour before the
 * start to two hours after the end (lib/sessions/checkin.ts). Under reduced
 * motion the first face simply stands.
 */
export function CheckinProof({ labels }: { labels: CheckinProofLabels }) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const faces = gsap.utils.toArray<SVGGElement>('[data-face]', root.current);
        const ring = root.current?.querySelector('[data-ring]');
        if (faces.length < 2 || !ring) return;
        const tl = gsap.timeline({
          scrollTrigger: { trigger: root.current, start: 'top 80%', once: true },
        });
        faces.forEach((current, i) => {
          const following = faces[(i + 1) % faces.length];
          tl.fromTo(
            ring,
            { strokeDashoffset: 0 },
            { strokeDashoffset: 100, duration: CYCLE, ease: 'none' },
          )
            .to(current, { autoAlpha: 0, scale: 0.9, transformOrigin: '50% 50%', duration: 0.25 })
            .fromTo(
              following ?? current,
              { autoAlpha: 0, scale: 1.1, transformOrigin: '50% 50%' },
              {
                autoAlpha: 1,
                scale: 1,
                duration: 0.3,
                ease: 'back.out(2)',
                // Its starting state belongs to its own turn, not to the moment
                // the timeline is built — the first face would vanish at once.
                immediateRender: false,
              },
              '<0.1',
            );
        });
        // It ends as it began: the first face inside a full ring.
        tl.set(ring, { strokeDashoffset: 0 });
      });
    },
    { scope: root },
  );

  const cell = 8;
  const grid = SIZE * cell;

  return (
    <div
      ref={root}
      className="mt-10 rounded-card border border-line bg-surface p-5 shadow-xs sm:p-6"
    >
      <h3 className="text-h4 font-extrabold tracking-tight text-ink">{labels.title}</h3>
      <div className="mt-5 grid gap-5 sm:grid-cols-3 sm:gap-4">
        <figure className="flex flex-col gap-3">
          <div className="relative grid h-28 place-items-center rounded-lg bg-paper">
            <span className="absolute right-2 top-2 rounded-pill bg-surface px-1.5 py-0.5 font-mono text-caption font-semibold text-accent-active">
              {labels.seconds}
            </span>
            <svg viewBox={`-14 -14 ${grid + 28} ${grid + 28}`} className="h-24" aria-hidden="true">
              <circle
                data-ring=""
                cx={grid / 2}
                cy={grid / 2}
                r={grid / 2 + 9}
                pathLength={100}
                fill="none"
                className="text-accent"
                stroke="currentColor"
                strokeWidth="3"
                strokeDasharray="100"
                transform={`rotate(-90 ${grid / 2} ${grid / 2})`}
              />
              {FACES.map((cells, f) => (
                <g
                  key={f}
                  data-face=""
                  className="text-ink"
                  fill="currentColor"
                  // Only the first face stands until the film turns them over.
                  style={f === 0 ? undefined : { opacity: 0, visibility: 'hidden' }}
                >
                  {cells.map((on, i) =>
                    on ? (
                      <rect
                        key={i}
                        x={(i % SIZE) * cell}
                        y={Math.floor(i / SIZE) * cell}
                        width={cell - 1}
                        height={cell - 1}
                        rx="1"
                      />
                    ) : null,
                  )}
                </g>
              ))}
            </svg>
          </div>
          <figcaption className="text-body-sm">
            <span className="flex items-center gap-1.5 font-bold text-ink">
              <QrCode size={16} aria-hidden="true" className="text-accent-active" />
              {labels.rotate.title}
            </span>
            <span className="mt-1 block text-ink-soft">{labels.rotate.body}</span>
          </figcaption>
        </figure>

        <figure className="flex flex-col gap-3">
          <div className="grid h-28 place-items-center rounded-lg bg-paper">
            <svg viewBox="0 0 120 90" className="h-24" aria-hidden="true">
              <circle
                cx="60"
                cy="48"
                r="36"
                className="text-brand"
                fill="currentColor"
                fillOpacity="0.12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />
              <g className="text-accent" fill="currentColor">
                <path d="M60 28c-6 0-10 4-10 10 0 7 10 16 10 16s10-9 10-16c0-6-4-10-10-10z" />
                <circle cx="60" cy="38" r="3.5" className="text-paper" fill="currentColor" />
              </g>
              <circle cx="80" cy="62" r="7" className="text-brand" fill="currentColor" />
            </svg>
          </div>
          <figcaption className="text-body-sm">
            <span className="flex items-center gap-1.5 font-bold text-ink">
              <MapPin size={16} aria-hidden="true" className="text-accent-active" />
              {labels.place.title}
            </span>
            <span className="mt-1 block text-ink-soft">{labels.place.body}</span>
          </figcaption>
        </figure>

        <figure className="flex flex-col gap-3">
          <div className="flex h-28 flex-col justify-center rounded-lg bg-paper px-1">
            {/* Four equal columns: each tick sits at its column's centre, so
                its label stands right under it. The window runs from the
                first tick to the last; the session is the darker middle. */}
            <div aria-hidden="true" className="relative h-3">
              <span className="absolute inset-y-0 left-[12.5%] right-[12.5%] rounded-pill bg-brand-subtle" />
              <span className="absolute inset-y-0 left-[37.5%] right-[37.5%] bg-brand" />
              {[12.5, 37.5, 62.5, 87.5].map((left) => (
                <span
                  key={left}
                  className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-brand-active"
                  style={{ left: `${left}%` }}
                />
              ))}
            </div>
            <div
              aria-hidden="true"
              className="mt-2 grid grid-cols-4 text-center font-mono text-[0.625rem] leading-tight text-ink-soft"
            >
              <span>{labels.ticks.before}</span>
              <span>{labels.ticks.start}</span>
              <span>{labels.ticks.end}</span>
              <span>{labels.ticks.after}</span>
            </div>
          </div>
          <figcaption className="text-body-sm">
            <span className="flex items-center gap-1.5 font-bold text-ink">
              <Clock size={16} aria-hidden="true" className="text-accent-active" />
              {labels.time.title}
            </span>
            <span className="mt-1 block text-ink-soft">{labels.time.body}</span>
          </figcaption>
        </figure>
      </div>
      <p className="mt-5 flex items-center gap-3 rounded-lg bg-accent-subtle px-4 py-3 text-body font-bold text-accent-active">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-accent font-mono text-body-sm text-on-accent"
        >
          {labels.points}
        </span>
        {labels.result}
      </p>
      <p className="mt-3 text-caption text-text-muted">{labels.without}</p>
    </div>
  );
}
