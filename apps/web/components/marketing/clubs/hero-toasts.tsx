'use client';

import { Bell } from 'lucide-react';
import { useRef } from 'react';

import { gsap, MOTION_OK, useGSAP } from '@/components/motion/gsap';

export interface HeroToast {
  title: string;
  body: string;
}

/**
 * The office as it is lived: small notices sliding over the dashboard's
 * picture, one after another, on a loop — a check-in, a new lead, a renewed
 * membership, a reminder sent. Illustrative words from the catalogue, no
 * record behind them. Under reduced motion the first notice simply stays.
 */
export function HeroToasts({ toasts }: { toasts: HeroToast[] }) {
  const root = useRef<HTMLUListElement>(null);
  useGSAP(
    () => {
      const scope = root.current;
      if (!scope) return;
      const items = Array.from(scope.querySelectorAll<HTMLElement>('[data-toast]'));
      if (items.length < 2) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        gsap.set(items.slice(1), { opacity: 0, x: 40 });
        const tl = gsap.timeline({ repeat: -1, delay: 1.2 });
        items.forEach((item, index) => {
          const next = items[(index + 1) % items.length];
          if (!next) return;
          tl.to(item, { opacity: 0, x: -24, duration: 0.4, ease: 'power2.in' }, '+=2.8').fromTo(
            next,
            { opacity: 0, x: 40 },
            { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out' },
            '-=0.1',
          );
        });
      });
    },
    { scope: root },
  );
  return (
    <ul
      ref={root}
      aria-hidden="true"
      className="pointer-events-none absolute bottom-4 left-4 right-4 sm:left-6 sm:right-auto sm:w-72"
    >
      {toasts.map((toast, index) => (
        <li
          key={toast.title}
          data-toast
          className={`${index === 0 ? '' : 'absolute inset-x-0 bottom-0 '}flex items-start gap-3 rounded-md border border-line bg-surface/95 p-3 shadow-lg backdrop-blur`}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-on-accent">
            <Bell size={16} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-body-sm font-bold text-ink">{toast.title}</span>
            <span className="block truncate text-caption text-ink-soft">{toast.body}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
