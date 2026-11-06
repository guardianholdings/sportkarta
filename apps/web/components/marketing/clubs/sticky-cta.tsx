'use client';

import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/** Marks an element the floating button must not cover: it hides while any one is on screen. */
export const STICKY_CTA_HIDE = 'data-sticky-cta-hide';

/**
 * The clubs page's one call to action, following the reader: a floating
 * button that appears once the first screen (the hero, `watchId`) has
 * scrolled away, and steps aside again whenever the reader is looking at a
 * call to action of the page's own — a plan card's button, the comparison
 * grid, the final screen: any element carrying `data-sticky-cta-hide` (UX
 * audit 2026-10-31, DR-01: on a phone it sat over the cards' own buttons and
 * ten pixels above the tab bar's «+», on a desktop over the «Про» column).
 * One IntersectionObserver over all of them. The button is fixed, so showing
 * and hiding it moves nothing else, and under reduced motion it fades without
 * sliding. Labels arrive as props, so this client component reads no
 * catalogue of its own (i18n/client-messages.ts stays as it is).
 */
export function StickyCta({
  watchId,
  href,
  label,
}: {
  watchId: string;
  href: '/klubove/zayavka';
  label: string;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const hero = document.getElementById(watchId);
    const targets = [
      ...(hero ? [hero] : []),
      ...document.querySelectorAll<HTMLElement>(`[${STICKY_CTA_HIDE}]`),
    ];
    if (targets.length === 0) return;
    const onScreen = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onScreen.add(entry.target);
          else onScreen.delete(entry.target);
        }
        setShown(onScreen.size === 0);
      },
      { threshold: 0 },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [watchId]);

  return (
    <div
      aria-hidden={!shown}
      className={cn(
        'sk-sticky-cta fixed bottom-24 right-4 z-30 transition-[opacity,transform] duration-200 ease-standard motion-reduce:transition-opacity lg:bottom-6 lg:right-6',
        shown
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-3 opacity-0 motion-reduce:translate-y-0',
      )}
    >
      <Link
        href={href}
        tabIndex={shown ? 0 : -1}
        className={cn(
          buttonVariants({ variant: 'accent', size: 'md' }),
          'shadow-lg lg:h-13 lg:px-6 lg:text-body',
        )}
      >
        {label}
        <ArrowRight size={20} aria-hidden="true" />
      </Link>
    </div>
  );
}
