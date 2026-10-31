'use client';

import { Pause, Play } from 'lucide-react';
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
  play: string;
  pause: string;
  /** "Стъпка {current} от {total}" — filled in here. */
  stepOf: string;
  steps: string;
  tabs?: string;
}

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

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
 * A screen recording made of real phone screens (lib/home/guide-recordings.ts):
 * the pictures play in a drawn phone while a touch lands where the finger did,
 * long pages scroll under the bottom bar, and the parts that matter light up.
 * Beside it, the steps as text — the recording's captions, and the content in
 * its own right: everything the film shows is also written down, and each step
 * is a button that jumps the film there.
 *
 * Plays only while it is on screen, and has a pause button (WCAG 2.2.2). Under
 * reduced motion nothing moves: each step is a still frame, chosen from the
 * list. Before hydration the first frame stands as the server drew it.
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
    // it would drop the focus of the tab just pressed and forget a pause.
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
  const phone = useRef<HTMLDivElement>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const starts = useRef<number[]>([]);
  const userPaused = useRef(false);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
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
      if (!screen) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const layers = gsap.utils.toArray<HTMLElement>('[data-layer]', screen);
        const bar = screen.querySelector<HTMLElement>('[data-bar]');
        const progress = gsap.utils.toArray<HTMLElement>('[data-progress]', root.current);
        const tl = gsap.timeline({
          paused: true,
          repeat: -1,
          repeatDelay: 1.2,
          onUpdate() {
            const time = tl.time();
            let index = 0;
            starts.current.forEach((start, i) => {
              if (time >= start) index = i;
            });
            show(index);
          },
        });
        starts.current = [];
        gsap.set(layers, { autoAlpha: 0 });
        gsap.set(screen.querySelectorAll('[data-tap]'), { autoAlpha: 0 });

        let cursor = 0;
        steps.forEach((step, i) => {
          const layer = layers[i];
          if (!layer) return;
          const start = cursor;
          starts.current.push(start);
          const marks = layer.querySelectorAll('[data-mark]');
          tl.set(layer, { y: 0, yPercent: 0 }, start);
          tl.set(marks, { autoAlpha: 0 }, start);
          if (bar) tl.set(bar, { autoAlpha: step.bar ? 1 : 0 }, start);
          tl.fromTo(
            layer,
            { autoAlpha: 0, xPercent: i === 0 ? 0 : 7 },
            { autoAlpha: 1, xPercent: 0, duration: 0.45, ease: 'power2.out' },
            start,
          );
          const previous = layers[i - 1];
          if (previous) {
            tl.to(
              previous,
              { autoAlpha: 0, xPercent: -7, duration: 0.45, ease: 'power2.out' },
              start,
            );
          } else if (layers.length > 1) {
            // The loop comes back round: the last screen gives way to the first.
            tl.set(layers.slice(1), { autoAlpha: 0 }, start);
          }
          cursor += 0.75;

          let scrolled = 0;
          let tapIndex = 0;
          let markIndex = 0;
          for (const action of step.actions) {
            if (action.type === 'scroll') {
              const to = clampScroll(step, action.to);
              const distance = Math.abs(to - scrolled);
              if (distance < 4) continue;
              const duration = gsap.utils.clamp(0.7, 2.2, distance / 650);
              tl.to(
                layer,
                { yPercent: -(to / step.h) * 100, duration, ease: 'power2.inOut' },
                cursor,
              );
              scrolled = to;
              cursor += duration + 0.35;
            } else if (action.type === 'tap') {
              const scope = action.on === 'bar' ? bar : layer;
              const touch = scope?.querySelector<HTMLElement>(`[data-tap="${i}-${tapIndex}"]`);
              tapIndex += 1;
              if (!touch) continue;
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
              cursor += 1.15;
            } else {
              const highlight = layer.querySelectorAll('[data-mark]')[markIndex];
              markIndex += 1;
              if (!highlight) continue;
              tl.fromTo(
                highlight,
                { autoAlpha: 0, scale: 1.06 },
                { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'back.out(2)' },
                cursor,
              );
              cursor += 1.4;
            }
          }
          cursor += 1.1;
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
        timeline.current = tl;
        // The first screen, entered, while the film waits to be scrolled to —
        // and the step list with it (seek() fires no onUpdate).
        tl.seek(0.5);
        activeRef.current = 0;
        setActive(0);
        setAnimated(true);

        const trigger = ScrollTrigger.create({
          trigger: root.current,
          start: 'top 75%',
          end: 'bottom 20%',
          onToggle(self) {
            if (self.isActive && !userPaused.current) {
              tl.play();
              setPlaying(true);
            } else if (!self.isActive) {
              tl.pause();
              setPlaying(false);
            }
          },
        });
        return () => {
          trigger.kill();
          timeline.current = null;
          setAnimated(false);
          setPlaying(false);
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

  // A hidden tab stops the film; it resumes where it was.
  useEffect(() => {
    const onVisibility = () => {
      const tl = timeline.current;
      if (!tl) return;
      if (document.hidden) tl.pause();
      else if (playing) tl.play();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [playing]);

  const jump = (index: number) => {
    const tl = timeline.current;
    if (tl) {
      tl.seek((starts.current[index] ?? 0) + 0.001);
    }
    show(index);
  };

  const toggle = () => {
    const tl = timeline.current;
    if (!tl) return;
    if (tl.paused()) {
      userPaused.current = false;
      tl.play();
      setPlaying(true);
    } else {
      userPaused.current = true;
      tl.pause();
      setPlaying(false);
    }
  };

  const stepOf = labels.stepOf
    .replace('{current}', String(active + 1))
    .replace('{total}', String(steps.length));

  return (
    <div ref={root} className="grid gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex min-w-0 flex-col items-center gap-4 lg:sticky lg:top-24 lg:self-start">
        {tabs}
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
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggle}
            disabled={!animated}
            className="sk-rec-play"
            aria-label={playing ? labels.pause : labels.play}
          >
            {playing ? (
              <Pause size={16} aria-hidden="true" />
            ) : (
              <Play size={16} aria-hidden="true" />
            )}
          </button>
          <span className="font-mono text-caption text-text-muted">{stepOf}</span>
        </div>
        {note && <p className="max-w-xs text-center text-caption text-text-muted">{note}</p>}
      </div>

      <div className="min-w-0">
        <ol
          aria-label={labels.steps}
          className="sk-rec-steps"
          data-static={animated ? undefined : ''}
        >
          {captions.map((caption, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => jump(i)}
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
        {children}
      </div>
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
