import { useGSAP as useGSAPNow } from '@gsap/react';
import { gsap } from 'gsap';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { type RefObject, useEffect, useState } from 'react';

/**
 * One registration for the whole app (gsap.registerPlugin is idempotent and
 * safe to run during SSR — the plugins check for a window themselves). Every
 * client component that animates imports from here, never from 'gsap'
 * directly, so the plugin set and the reduced-motion query live in one place.
 *
 * MOTION_OK is the matchMedia() condition every animation is created under:
 * a reader who asked for reduced motion gets the final state, rendered by
 * the server, and no tween at all.
 */
gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin, useGSAPNow);

export const MOTION_OK = '(prefers-reduced-motion: no-preference)';

/** How far ahead of the viewport an animation is built: one screen, either way. */
const NEAR_MARGIN = '100% 0px';

/**
 * Re-measure every scroll trigger, once, after the reader's scrolling has
 * settled (`refresh(true)`): something above or around them changed height.
 */
let remeasureQueued = false;
function remeasure(): void {
  if (remeasureQueued || ScrollTrigger.getAll().length === 0) return;
  remeasureQueued = true;
  requestAnimationFrame(() => {
    remeasureQueued = false;
    ScrollTrigger.refresh(true);
  });
}

/**
 * A section marked `.sk-later` (globals.css) is not laid out until the browser
 * judges it near, and stands in the page at a guessed height until then. Two
 * consequences for anything that measures the page:
 *
 * - a block is laid out FOR GOOD before its animation is built, so its setup
 *   reads real boxes rather than an empty placeholder (`layOut`);
 * - whenever the browser lays a section out, or skips one again, everything
 *   below it moves, so the triggers already built are measured again.
 */
function layOut(element: Element): void {
  const section = element.closest<HTMLElement>('.sk-later');
  if (!section || section.style.contentVisibility === 'visible') return;
  section.style.contentVisibility = 'visible';
  remeasure();
}
if (typeof document !== 'undefined') {
  document.addEventListener('contentvisibilityautostatechange', remeasure, true);
}

/**
 * True once `scope` has come within a screen of the viewport, and from then on.
 * An element that is never laid out (hidden at this width) never comes near,
 * and its animation is never built — which is right.
 */
function useNear(scope: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = scope.current;
    if (near || !element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        layOut(element);
        setNear(true);
      },
      { rootMargin: NEAR_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scope, near]);
  return near;
}

/**
 * useGSAP, built when its block is about to be seen instead of when the page
 * loads.
 *
 * Every animation on the front page — the scroll-driven recordings, the
 * check-in proof, the streak strip, the division ladder, the reveals — used
 * to be set up during hydration, screens before a visitor could reach the
 * first of them. Setting one up reads computed styles and measures layout,
 * and on a page of 3,500 elements each read forces the whole layout:
 * PageSpeed attributed 735 ms of forced layout on a phone to it (2026-11-16),
 * all inside the load, for motion most visits never scroll to. Now a block's
 * setup runs when the block comes within a screen of the viewport, so the
 * work is done near where it is used, and a visit that never scrolls pays
 * for none of it.
 *
 * Same call as @gsap/react's hook, with `scope` required: the scope is what is
 * watched. Until the block is near, it stands as the server rendered it — the
 * same state a reader with reduced motion keeps.
 */
export function useGSAP(
  /** May return a cleanup function, as with the hook it wraps. */
  setup: () => unknown,
  config: {
    scope: RefObject<Element | null>;
    dependencies?: unknown[];
    revertOnUpdate?: boolean;
  },
): void {
  const near = useNear(config.scope);
  useGSAPNow(
    () => {
      if (!near) return;
      return setup();
    },
    { ...config, dependencies: [...(config.dependencies ?? []), near] },
  );
}

export { gsap, ScrollTrigger };
