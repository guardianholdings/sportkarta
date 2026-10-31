'use client';

import { Camera, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { scanTarget } from '@/lib/scan-target';

/**
 * The live QR reader of /skenirai. Frames stay in this tab: they are read
 * here and never stored or sent anywhere — only the decoded check-in path is
 * followed, and only when lib/scan-target.ts accepts it.
 *
 * The camera starts by itself: the member reached this page by tapping
 * «Сканирай QR», which is the gesture that asks for it. Two decoders, the
 * browser's own `BarcodeDetector` where it has one (Chrome on Android) and
 * jsQR on a downscaled canvas otherwise (Safari, Firefox) — loaded only then,
 * so phones that do not need it never download it. When there is no camera,
 * or the member said no, a photo of the code goes through the same decoder.
 */

type Phase = 'starting' | 'scanning' | 'opening' | 'denied' | 'unavailable';
type Problem = 'notOurs' | 'unreadable' | null;

/** Frames are read four times a second; a phone does not need more. */
const SCAN_EVERY_MS = 250;
/**
 * jsQR's cost grows with the pixel count. A live frame is aimed, so the code
 * fills it; a photo may hold a small code in twelve megapixels, so it keeps
 * more of them.
 */
const LIVE_DECODE_WIDTH = 640;
const PHOTO_DECODE_WIDTH = 1600;

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

async function nativeDetector(): Promise<Detector | null> {
  const Ctor = (window as unknown as { BarcodeDetector?: new (o: object) => Detector })
    .BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = await (
      Ctor as unknown as { getSupportedFormats?: () => Promise<string[]> }
    ).getSupportedFormats?.();
    if (formats && !formats.includes('qr_code')) return null;
    return new Ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

/** Reads one QR from an image source, or null. */
async function decode(
  source: HTMLVideoElement | ImageBitmap,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  detector: Detector | null,
  maxWidth: number,
): Promise<string | null> {
  if (detector) {
    const found = await detector.detect(source);
    return found[0]?.rawValue ?? null;
  }
  const scale = Math.min(1, maxWidth / width);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { default: jsQR } = await import('jsqr');
  return jsQR(data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

export function QrScanner({ siteOrigin }: { siteOrigin: string }) {
  const t = useTranslations('Scan');
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Set once a code is being opened: neither the live loop nor a photo may
  // open a second one, and nothing opens after the page is left.
  const doneRef = useRef(false);
  // Leaving the page counts as done: a photo still decoding must not pull
  // the member back to a check-in they walked away from.
  // (Reset on mount as well: development's double effect run must not leave a
  // fresh scanner thinking it is finished.)
  useEffect(() => {
    doneRef.current = false;
    return () => {
      doneRef.current = true;
    };
  }, []);
  const [phase, setPhase] = useState<Phase>('starting');
  const [problem, setProblem] = useState<Problem>(null);
  const [attempt, setAttempt] = useState(0);

  const canvas = () => (canvasRef.current ??= document.createElement('canvas'));

  const stop = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  /** A decoded string: open it when it is ours, say so when it is not. */
  const handle = useCallback(
    (raw: string | null, from: 'live' | 'photo') => {
      if (doneRef.current) return true;
      if (raw === null) {
        if (from === 'photo') setProblem('unreadable');
        return false;
      }
      const path = scanTarget(raw, [window.location.origin, siteOrigin]);
      if (!path) {
        setProblem('notOurs');
        return false;
      }
      doneRef.current = true;
      stop();
      setPhase('opening');
      router.push(path);
      return true;
    },
    [router, siteOrigin, stop],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setPhase('starting');
    setProblem(null);

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setPhase('unavailable');
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof DOMException ? error.name : '';
        setPhase(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      // Always mounted (hidden while there is no picture), so a retry finds it.
      const video = videoRef.current;
      if (!video) {
        stop();
        setPhase('unavailable');
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const detector = await nativeDetector();
      if (cancelled) return;
      setPhase('scanning');

      const tick = async () => {
        if (cancelled || doneRef.current) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            const raw = await decode(
              video,
              video.videoWidth,
              video.videoHeight,
              canvas(),
              detector,
              LIVE_DECODE_WIDTH,
            );
            // Left while the frame was being read: open nothing.
            if (cancelled) return;
            if (handle(raw, 'live')) return;
          } catch {
            // One unreadable frame is not an error; the next one may read.
          }
        }
        timer = window.setTimeout(() => void tick(), SCAN_EVERY_MS);
      };
      void tick();
    }

    void start();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stop();
    };
  }, [attempt, handle, stop]);

  async function onPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || doneRef.current) return;
    setProblem(null);
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      const raw = await decode(
        bitmap,
        bitmap.width,
        bitmap.height,
        canvas(),
        await nativeDetector(),
        PHOTO_DECODE_WIDTH,
      );
      handle(raw, 'photo');
    } catch {
      setProblem('unreadable');
    } finally {
      bitmap?.close();
    }
  }

  const live = phase === 'starting' || phase === 'scanning' || phase === 'opening';

  return (
    <div className="flex flex-col gap-4">
      {/* The video stays mounted whatever the phase, so «Опитай отново» has
          somewhere to put the stream. */}
      <div
        hidden={!live}
        className="relative aspect-square w-full overflow-hidden rounded-card bg-ink"
      >
        <video ref={videoRef} playsInline muted className="size-full object-cover" aria-hidden />
        {/* The aiming frame: decoration, the whole picture is read. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-[18%] rounded-card border-[3px] border-on-accent/90 shadow-[0_0_0_9999px_var(--overlay-scrim)]"
        />
      </div>
      {!live && (
        <div
          role="alert"
          className="rounded-card border border-line bg-surface p-4 text-body-sm text-ink"
        >
          {t(phase === 'denied' ? 'denied' : 'unavailable')}
        </div>
      )}

      <p
        role="status"
        aria-live="polite"
        className="min-h-6 text-body-sm font-medium text-ink-soft"
      >
        {problem
          ? t(problem)
          : phase === 'starting'
            ? t('starting')
            : phase === 'scanning'
              ? t('scanning')
              : phase === 'opening'
                ? t('opening')
                : ''}
      </p>

      <div className="flex flex-wrap gap-2.5">
        {!live && (
          <Button
            variant="secondary"
            iconLeft={<RotateCcw size={18} />}
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t('retry')}
          </Button>
        )}
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink hover:bg-surface-2 focus-within:shadow-[var(--ring)]">
          <Camera size={18} />
          {t('photo')}
          <input
            type="file"
            accept="image/*"
            // Straight to the camera: this input exists to photograph a code.
            capture="environment"
            onChange={(e) => void onPhoto(e)}
            className="sr-only"
          />
        </label>
      </div>
    </div>
  );
}
