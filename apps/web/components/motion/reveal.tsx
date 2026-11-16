'use client';

import { useRef, type ReactNode } from 'react';

import { gsap, MOTION_OK, useGSAP } from './gsap';

/**
 * Scroll-in for a SEQUENCE — the stops of a route, the stages of a process,
 * steps one to three: its `[data-reveal]` descendants (or the block itself
 * when it has none) arrive in their order the first time the block reaches
 * the lower part of the viewport. Only where the order is the content: a
 * section, a heading or a grid of equals stands where the server put it, and
 * a page that fades every block in as it scrolls says nothing with the motion.
 * Transform and opacity only, so nothing moves in the layout; under reduced
 * motion the block simply is where the server put it.
 */
export function Reveal({
  children,
  className,
  stagger = 0.08,
  y = 12,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
  y?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const root = ref.current;
      if (!root) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const items = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
        gsap.from(items.length ? items : root, {
          opacity: 0,
          y,
          duration: 0.5,
          ease: 'expo.out',
          stagger,
          clearProps: 'transform',
          scrollTrigger: { trigger: root, start: 'top 85%', once: true },
        });
      });
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
