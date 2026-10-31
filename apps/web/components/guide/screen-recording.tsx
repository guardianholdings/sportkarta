'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { gsap, MOTION_OK, ScrollTrigger, useGSAP } from '@/components/motion/gsap';
import {
  PHONE_HEIGHT,
  PHONE_WIDTH,
  type RecAction,
  type RecBox,
  type Recording,
  type RecStep,
} from '@/lib/home/guide-recording-types';
import { cn } from '@/lib/utils';

export interface RecordingTrack {
  key: string;
  /** The tab's name when a chapter shows more than one recording. */
  tab?: string;
  /** «Запис на екрана: как се намира място» — the phone's accessible name. */
  label: string;
  recording: Recording;
  steps: { title: string; body: string }[];
}

export interface RecordingLabels {
  /** "Стъпка {current} от {total}" — filled in here. */
  stepOf: string;
  steps: string;
  tabs?: string;
}

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

/** The film's beats, in seconds: a screen coming in, a touch, a frame landing, the rest after a step. */
const ENTER = 0.75;
const TAP = 1.15;
const MARK = 1.4;
const HOLD = 1.1;
/** A long page scrolls a little longer, within bounds; then a breath. */
const scrollSeconds = (distance: number) => Math.min(2.2, Math.max(0.7, distance / 650));
const SCROLL_REST = 0.35;

/** Where a box sits on its picture, as percentages, so it scales with the phone. */
function place(box: RecBox, height: number): CSSProperties {
  return {
    left: pct(box.x, PHONE_WIDTH),
    top: pct(box.y, height),
    width: pct(box.w, PHONE_WIDTH),
    height: pct(box.h, height),
  };
}

/** The farthest a picture may scroll: its foot meets the screen's foot. */
function clampScroll(step: RecStep, to: number): number {
  return Math.max(0, Math.min(to, step.h - PHONE_HEIGHT));
}

/** Where a still frame rests: after the step's last scroll, so its marks are in view. */
function restingScroll(step: RecStep): number {
  const scrolls = step.actions.filter(
    (a): a is Extract<RecAction, { type: 'scroll' }> => a.type === 'scroll',
  );
  const last = scrolls.at(-1);
  return last ? clampScroll(step, last.to) : 0;
}

/**
 * How long a step's part of the film runs — the sums the timeline below adds
 * up. A step gets page height in proportion, so a screen with more to show
 * also gets more scrolling.
 */
function stepSeconds(step: RecStep): number {
  let seconds = ENTER;
  let scrolled = 0;
  for (const action of step.actions) {
    if (action.type === 'scroll') {
      const to = clampScroll(step, action.to);
      const distance = Math.abs(to - scrolled);
      if (distance < 4) continue;
      seconds += scrollSeconds(distance) + SCROLL_REST;
      scrolled = to;
    } else {
      seconds += action.type === 'tap' ? TAP : MARK;
    }
  }
  return seconds + HOLD;
}

/**
 * A screen recording made of real phone screens (lib/home/guide-recordings.ts):
 * the pictures play in a drawn phone while a touch lands where the finger did,
 * long pages scroll under the bottom bar, and the parts that matter light up.
 * Beside it, the steps as text — the recording's captions, and the content in
 * its own right: everything the film shows is also written down.
 *
 * The film follows the reader's scrolling: the phone holds still (beside the
 * steps on a wide screen, above them on a phone) and each step plays while its
 * text passes, so no step goes by unseen and nothing moves that the reader did
 * not move — hence no pause button (WCAG 2.2.2 is about motion that starts by
 * itself). A step's button scrolls to it. Under reduced motion nothing moves:
 * each step is a still frame, chosen from the list. Before hydration the first
 * frame stands as the server drew it.
 */
export function ScreenRecording({
  tracks,
  labels,
  note,
  children,
}: {
  tracks: RecordingTrack[];
  labels: RecordingLabels;
  note?: string;
  children?: ReactNode;
}) {
  const [trackIndex, setTrackIndex] = useState(0);
  const track = tracks[trackIndex] ?? tracks[0];
  if (!track) return null;

  return (
    // Not keyed by track: the tab buttons live inside the player, and remounting
    // it would drop the focus of the tab just pressed.
    <Player
      track={track}
      labels={labels}
      note={note}
      tabs={
        tracks.length > 1 ? (
          <div role="group" aria-label={labels.tabs} className="sk-rec-tabs">
            {tracks.map((t, index) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={index === trackIndex}
                onClick={() => setTrackIndex(index)}
                className="sk-rec-tab"
              >
                {t.tab}
              </button>
            ))}
          </div>
        ) : null
      }
    >
      {children}
    </Player>
  );
}

function Player({
  track,
  labels,
  note,
  tabs,
  children,
}: {
  track: RecordingTrack;
  labels: RecordingLabels;
  note?: string;
  tabs: ReactNode;
  children?: ReactNode;
}) {
  const { recording, steps: captions } = track;
  const steps = recording.steps;
  const root = useRef<HTMLDivElement>(null);
  const scrolly = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLDivElement>(null);
  const film = useRef<HTMLDivElement>(null);
  const phone = useRef<HTMLDivElement>(null);
  /** The page-scroll positions where each step begins; the last one is where the film ends. */
  const bounds = useRef<number[]>([]);
  const built = useRef(false);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);
  const [animated, setAnimated] = useState(false);
  // The first screen loads with the page; the rest only once the film comes
  // within reach of the screen — then all of them, so no step ever opens on a
  // picture still on its way (a hidden lazy image is not fetched until shown).
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const show = useCallback((index: number) => {
    if (activeRef.current === index) return;
    activeRef.current = index;
    setActive(index);
  }, []);

  useGSAP(
    () => {
      const screen = phone.current;
      const box = scrolly.current;
      const column = media.current;
      const pinned = film.current;
      if (!screen || !box || !column || !pinned) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const layers = gsap.utils.toArray<HTMLElement>('[data-layer]', screen);
        const bar = screen.querySelector<HTMLElement>('[data-bar]');
        const progress = gsap.utils.toArray<HTMLElement>('[data-progress]', box);
        const items = gsap.utils.toArray<HTMLElement>('[data-step]', box);
        const rooms = gsap.utils.toArray<HTMLElement>('[data-room]', box);
        const tl = gsap.timeline({ paused: true });
        const starts: number[] = [];

        // The first screen's state is set, not timed: a zero-length tween at a
        // timeline's very start reverts when the playhead is scrolled back to it.
        gsap.set(layers, { autoAlpha: 0, xPercent: 0, y: 0, yPercent: 0 });
        if (layers[0]) gsap.set(layers[0], { autoAlpha: 1 });
        gsap.set(screen.querySelectorAll('[data-tap]'), { autoAlpha: 0 });
        gsap.set(screen.querySelectorAll('[data-mark]'), { autoAlpha: 0 });
        if (bar) gsap.set(bar, { autoAlpha: steps[0]?.bar ? 1 : 0 });

        let cursor = 0;
        steps.forEach((step, i) => {
          const layer = layers[i];
          if (!layer) return;
          const start = cursor;
          starts.push(start);
          const previous = layers[i - 1];
          if (previous) {
            if (bar) tl.set(bar, { autoAlpha: step.bar ? 1 : 0 }, start);
            tl.fromTo(
              layer,
              { autoAlpha: 0, xPercent: 7 },
              { autoAlpha: 1, xPercent: 0, duration: 0.45, ease: 'power2.out' },
              start,
            ).to(
              previous,
              { autoAlpha: 0, xPercent: -7, duration: 0.45, ease: 'power2.out' },
              start,
            );
          }
          cursor += ENTER;

          let scrolled = 0;
          let tapIndex = 0;
          let markIndex = 0;
          for (const action of step.actions) {
            if (action.type === 'scroll') {
              const to = clampScroll(step, action.to);
              const distance = Math.abs(to - scrolled);
              if (distance < 4) continue;
              const duration = scrollSeconds(distance);
              tl.to(
                layer,
                { yPercent: -(to / step.h) * 100, duration, ease: 'power2.inOut' },
                cursor,
              );
              scrolled = to;
              cursor += duration + SCROLL_REST;
            } else if (action.type === 'tap') {
              const scope = action.on === 'bar' ? bar : layer;
              const touch = scope?.querySelector<HTMLElement>(`[data-tap="${i}-${tapIndex}"]`);
              tapIndex += 1;
              if (touch) {
                const ring = touch.querySelector('[data-ring]');
                tl.fromTo(
                  touch,
                  { autoAlpha: 0, scale: 1.7 },
                  { autoAlpha: 1, scale: 1, duration: 0.28, ease: 'power2.out' },
                  cursor,
                )
                  .to(touch, { scale: 0.8, duration: 0.14, ease: 'power1.in' }, cursor + 0.32)
                  .fromTo(
                    ring,
                    { scale: 0.6, autoAlpha: 0.9 },
                    { scale: 2.4, autoAlpha: 0, duration: 0.6, ease: 'power2.out' },
                    cursor + 0.42,
                  )
                  .to(touch, { autoAlpha: 0, scale: 1, duration: 0.3 }, cursor + 0.8);
              }
              cursor += TAP;
            } else {
              const highlight = layer.querySelectorAll('[data-mark]')[markIndex];
              markIndex += 1;
              if (highlight) {
                tl.fromTo(
                  highlight,
                  { autoAlpha: 0, scale: 1.06 },
                  { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'back.out(2)' },
                  cursor,
                );
              }
              cursor += MARK;
            }
          }
          cursor += HOLD;
          const bar_ = progress[i];
          if (bar_) {
            tl.fromTo(
              bar_,
              { scaleX: 0 },
              { scaleX: 1, duration: cursor - start, ease: 'none' },
              start,
            );
          }
        });
        const total = cursor;

        // Page scroll → the film: a step runs while its stretch of the page
        // passes a line, and the last ends as the phone lets go. Beside the
        // phone, the stretches are the steps themselves and the line is where
        // their text holds (sticky, CSS). On a phone, the phone and the step
        // being read hold together at the top, and empty room below them, a
        // block per step, passes under their foot.
        const measure = () => {
          const top = (el: Element) => el.getBoundingClientRect().top + window.scrollY;
          const wide = window.matchMedia('(min-width: 1024px)').matches;
          const holder = wide ? column : pinned;
          const held = (parseFloat(getComputedStyle(holder).top) || 0) + holder.offsetHeight;
          const text = items[0]?.firstElementChild;
          const line =
            wide && text
              ? parseFloat(getComputedStyle(text).top) || window.innerHeight * 0.35
              : held;
          const b: number[] = [];
          for (const mark of wide ? items : rooms) {
            b.push(Math.max((b.at(-1) ?? -Infinity) + 1, top(mark) - line));
          }
          b.push(Math.max((b.at(-1) ?? 0) + 1, top(box) + box.offsetHeight - held));
          bounds.current = b;
          return b;
        };
        const at = (scroll: number) => {
          const b = bounds.current;
          let i = 0;
          while (i < starts.length - 1 && scroll >= (b[i + 1] ?? Infinity)) i += 1;
          const from = b[i] ?? 0;
          const to = b[i + 1] ?? from + 1;
          const local = gsap.utils.clamp(0, 1, (scroll - from) / (to - from));
          const begin = starts[i] ?? 0;
          return { index: i, time: begin + local * ((starts[i + 1] ?? total) - begin) };
        };

        // The film eases after the scroll rather than jumping with every wheel notch.
        const playhead = { time: 0 };
        const follow = gsap.quickTo(playhead, 'time', {
          duration: 0.5,
          ease: 'power3.out',
          onUpdate: () => {
            tl.time(playhead.time, true);
          },
        });
        const land = (scroll: number, now = false) => {
          const { index, time } = at(scroll);
          show(index);
          if (now) {
            follow(time, time);
            tl.time(time, true);
          } else {
            follow(time);
          }
        };

        const trigger = ScrollTrigger.create({
          trigger: box,
          start: () => measure()[0] ?? 0,
          end: () => measure().at(-1) ?? 0,
          onUpdate: (self) => land(self.scroll()),
          onRefresh: (self) => land(self.scroll(), true),
        });
        land(trigger.scroll(), true);
        setAnimated(true);
        // Another track changed the page's height: everything below re-measures.
        if (built.current) ScrollTrigger.refresh();
        built.current = true;

        return () => {
          trigger.kill();
          bounds.current = [];
          setAnimated(false);
        };
      });
    },
    // A new track rebuilds the film; the old one is reverted first.
    { scope: root, dependencies: [track.key], revertOnUpdate: true },
  );

  // Another track starts at its own first step (a still frame included).
  useEffect(() => {
    activeRef.current = 0;
    setActive(0);
  }, [track.key]);

  const jump = (index: number) => {
    const at = bounds.current[index];
    if (animated && at !== undefined) {
      // The scroll moves the film and the list; a hair past the step's start,
      // so it is the one that lights up.
      window.scrollTo({ top: at + 2, behavior: 'smooth' });
      return;
    }
    show(index);
  };

  const stepOf = labels.stepOf
    .replace('{current}', String(active + 1))
    .replace('{total}', String(steps.length));

  return (
    <div ref={root}>
      {(tabs || note) && (
        <div className="mb-6 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-x-14">
          <div className="flex flex-col items-center gap-3">
            {tabs}
            {note && <p className="max-w-xs text-center text-caption text-text-muted">{note}</p>}
          </div>
        </div>
      )}
      <div ref={scrolly} className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-x-14">
        {/* The phone and the steps; on a wide screen the two are the grid's
            columns (display: contents), on a phone they hold together. */}
        <div ref={film} className="sk-rec-film">
          <div
            ref={media}
            className="sk-rec-media flex min-w-0 flex-col items-center gap-2 lg:sticky lg:top-24 lg:self-start"
          >
            <div className="sk-rec-stage">
              <div
                ref={phone}
                role="img"
                aria-label={track.label}
                className="sk-phone"
                data-static={animated ? undefined : ''}
              >
                <div className="sk-phone__screen" aria-hidden="true">
                  <div className="sk-phone__status">
                    <span>9:41</span>
                    <span className="sk-phone__island" />
                    <span className="sk-phone__icons">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  <div className="sk-phone__viewport">
                    {steps.map((step, i) => (
                      <Layer
                        key={step.src}
                        step={step}
                        index={i}
                        active={active === i}
                        still={!animated}
                        load={near}
                      />
                    ))}
                    {recording.bar && (
                      <div
                        data-bar=""
                        data-hidden={!animated && !steps[active]?.bar ? '' : undefined}
                        className="sk-rec-bar"
                        style={{ height: pct(recording.bar.h, PHONE_HEIGHT) }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- a committed screenshot strip */}
                        <img
                          src={recording.bar.src}
                          alt=""
                          width={recording.bar.w}
                          height={recording.bar.h}
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                        />
                        {steps.map((step, i) => {
                          let tap = 0;
                          return step.actions.map((action) => {
                            if (action.type !== 'tap') return null;
                            const id = `${i}-${tap++}`;
                            return action.on === 'bar' ? (
                              <Touch
                                key={id}
                                id={id}
                                box={action}
                                height={recording.bar?.h ?? 1}
                                visible={!animated && active === i}
                              />
                            ) : null;
                          });
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <span className="sk-rec-media__count font-mono text-caption text-text-muted">
              {stepOf}
            </span>
          </div>

          <ol
            aria-label={labels.steps}
            className="sk-rec-steps min-w-0"
            data-static={animated ? undefined : ''}
          >
            {captions.map((caption, i) => (
              <li
                key={i}
                data-step=""
                style={
                  { '--rec-s': steps[i] ? stepSeconds(steps[i]).toFixed(2) : 3 } as CSSProperties
                }
              >
                <button
                  type="button"
                  onClick={() => jump(i)}
                  // On a phone the steps not being read are faded out: reaching
                  // one with the keyboard scrolls the film to it.
                  onFocus={() => {
                    if (activeRef.current !== i) jump(i);
                  }}
                  aria-current={active === i ? 'step' : undefined}
                  className="sk-rec-step"
                >
                  <span className="sk-rec-step__num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-body font-bold text-ink">{caption.title}</span>
                    <span className="mt-0.5 block text-body-sm text-ink-soft">{caption.body}</span>
                  </span>
                  <span className="sk-rec-step__track" aria-hidden="true">
                    <span data-progress="" />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="sk-rec-room" aria-hidden="true">
          {steps.map((step) => (
            <div
              key={step.src}
              data-room=""
              style={{ '--rec-s': stepSeconds(step).toFixed(2) } as CSSProperties}
            />
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

function Layer({
  step,
  index,
  active,
  still,
  load,
}: {
  step: RecStep;
  index: number;
  active: boolean;
  /** No film (reduced motion, or before it is built): the touches stand still. */
  still: boolean;
  /** Whether this picture may be fetched yet (the first always may). */
  load: boolean;
}) {
  let tap = 0;
  const rest = restingScroll(step);
  return (
    <div
      data-layer=""
      data-active={active ? 'true' : undefined}
      className="sk-rec-layer"
      style={{ transform: `translateY(${-(rest / step.h) * 100}%)` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a committed screenshot */}
      <img
        src={index === 0 || load ? step.src : undefined}
        alt=""
        width={step.w}
        height={step.h}
        loading={index === 0 ? 'lazy' : undefined}
        decoding="async"
        draggable={false}
      />
      {step.actions.map((action, j) => {
        if (action.type === 'mark') {
          return (
            <span key={j} data-mark="" className="sk-rec-mark" style={place(action, step.h)} />
          );
        }
        if (action.type === 'tap') {
          const id = `${index}-${tap++}`;
          return action.on === 'screen' ? (
            <Touch key={j} id={id} box={action} height={step.h} visible={still && active} />
          ) : null;
        }
        return null;
      })}
    </div>
  );
}

/** A touch, drawn as phones draw "show touches": a soft disc and a ripple. */
function Touch({
  id,
  box,
  height,
  visible,
}: {
  id: string;
  box: RecBox;
  height: number;
  visible: boolean;
}) {
  return (
    <span
      data-tap={id}
      className={cn('sk-rec-touch', visible && 'is-still')}
      style={{
        left: pct(box.x + box.w / 2, PHONE_WIDTH),
        top: pct(box.y + box.h / 2, height),
      }}
    >
      <span data-ring="" />
    </span>
  );
}
