'use client';

import { useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { gsap, MOTION_OK, useGSAP } from './gsap';

/**
 * A card that leans towards the pointer — a few degrees of 3D rotation,
 * eased, only on devices that hover and only without a reduced-motion
 * preference. Touch screens and keyboards see the flat card.
 */
export function Tilt({
  children,
  className,
  max = 7,
}: {
  children: ReactNode;
  className?: string;
  /** Degrees at the card's edge. */
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(`${MOTION_OK} and (hover: hover)`, () => {
        gsap.set(el, { transformPerspective: 900 });
        const rotateX = gsap.quickTo(el, 'rotationX', { duration: 0.5, ease: 'power3' });
        const rotateY = gsap.quickTo(el, 'rotationY', { duration: 0.5, ease: 'power3' });
        const move = (event: PointerEvent) => {
          const rect = el.getBoundingClientRect();
          const px = (event.clientX - rect.left) / rect.width - 0.5;
          const py = (event.clientY - rect.top) / rect.height - 0.5;
          rotateY(px * max * 2);
          rotateX(-py * max * 2);
        };
        const leave = () => {
          rotateX(0);
          rotateY(0);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerleave', leave);
        return () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerleave', leave);
        };
      });
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className={cn('will-change-transform', className)}>
      {children}
    </div>
  );
}
