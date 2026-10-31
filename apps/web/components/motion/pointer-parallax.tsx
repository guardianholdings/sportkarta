'use client';

import { useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { gsap, MOTION_OK, useGSAP } from './gsap';

/**
 * The child drifts a few pixels against the pointer while it is over the
 * block — depth without a library of layers. Pointer devices only, never
 * under reduced motion; the drift is on the wrapper, so the child's own
 * hover targets keep their positions.
 */
export function PointerParallax({
  children,
  className,
  strength = 10,
}: {
  children: ReactNode;
  className?: string;
  /** Pixels of drift at the block's edge. */
  strength?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(`${MOTION_OK} and (hover: hover)`, () => {
        const x = gsap.quickTo(el, 'x', { duration: 0.8, ease: 'power3' });
        const y = gsap.quickTo(el, 'y', { duration: 0.8, ease: 'power3' });
        const move = (event: PointerEvent) => {
          const rect = el.getBoundingClientRect();
          x(((event.clientX - rect.left) / rect.width - 0.5) * -strength * 2);
          y(((event.clientY - rect.top) / rect.height - 0.5) * -strength * 2);
        };
        const leave = () => {
          x(0);
          y(0);
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
    // min-w-0: a wrapper in a grid must not let its child's intrinsic width
    // widen the track (the dot map's SVG would push a phone viewport wide).
    <div ref={ref} className={cn('min-w-0', className)}>
      {children}
    </div>
  );
}
