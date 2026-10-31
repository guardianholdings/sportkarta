import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

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
gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin, useGSAP);

export const MOTION_OK = '(prefers-reduced-motion: no-preference)';

export { gsap, ScrollTrigger, useGSAP };
