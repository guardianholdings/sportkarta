'use client';

import { useEffect, useRef, useState } from 'react';

import { gsap, useGSAP } from '@/components/motion/gsap';
import { cn } from '@/lib/utils';

/**
 * The guide's chapter bar: the five chapters (and «Още») as stops on a route,
 * sticky while the guide is on screen. The stop being read is marked, the ones
 * behind turn green, and a coral line under the bar is how far through the
 * guide the reader is. Plain anchors: it works before and without JavaScript.
 */
export function GuideNav({
  label,
  guideId,
  items,
}: {
  label: string;
  guideId: string;
  items: { id: string; label: string }[];
}) {
  const nav = useRef<HTMLElement>(null);
  const progress = useRef<HTMLSpanElement>(null);
  const [current, setCurrent] = useState(-1);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const ids = items.map((item) => item.id);
    const seen = new Map<string, boolean>();
    // A band across the upper middle of the screen: the chapter in it is the
    // one being read.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting);
        const index = ids.findIndex((id) => seen.get(id));
        if (index !== -1) {
          setCurrent(index);
          return;
        }
        // Back above the first chapter (the hero, the contents): no stop is
        // being read. Between chapters, the last one stays marked.
        const first = ids[0] ? document.getElementById(ids[0]) : null;
        if (first && first.getBoundingClientRect().top > window.innerHeight * 0.35) {
          setCurrent(-1);
        }
      },
      { rootMargin: '-35% 0px -60% 0px' },
    );
    for (const id of ids) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [items]);

  // On a phone the bar scrolls sideways; keep the current stop in it.
  useEffect(() => {
    const strip = nav.current?.firstElementChild as HTMLElement | null;
    const stop = strip?.querySelector<HTMLElement>(`[data-stop="${current}"]`);
    if (!strip || !stop) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    strip.scrollTo({
      left: stop.offsetLeft - (strip.clientWidth - stop.clientWidth) / 2,
      behavior: still ? 'auto' : 'smooth',
    });
  }, [current]);

  useGSAP(
    () => {
      const guide = document.getElementById(guideId);
      if (!guide || !progress.current) return;
      // Follows the reader's own scrolling, so it is not motion they did not ask for.
      gsap.to(progress.current, {
        scaleX: 1,
        ease: 'none',
        scrollTrigger: { trigger: guide, start: 'top top', end: 'bottom bottom', scrub: true },
      });
    },
    { scope: nav },
  );

  return (
    <nav ref={nav} aria-label={label} className="sk-guide-nav">
      <div className="scrollbar-none mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-2 py-1.5 sm:px-4 lg:px-6">
        {items.map((item, index) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            data-stop={index}
            aria-current={index === current ? 'location' : undefined}
            className={cn('sk-guide-nav__link', index < current && 'is-past')}
          >
            <span aria-hidden="true" className="sk-guide-nav__stop">
              {index + 1}
            </span>
            {item.label}
          </a>
        ))}
      </div>
      <span ref={progress} aria-hidden="true" className="sk-guide-nav__progress" />
    </nav>
  );
}
