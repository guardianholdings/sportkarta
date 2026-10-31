'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Re-mounts its children the first time they scroll into view, so a CSS
 * entrance that played at load far below the fold (the odometers' roll)
 * plays again where somebody can see it. Under reduced motion nothing is
 * re-mounted: the numbers are simply there.
 */
export function InViewKey({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setGeneration(1);
          observer.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      <div key={generation}>{children}</div>
    </div>
  );
}
