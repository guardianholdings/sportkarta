import { cn } from '@/lib/utils';

import type { Shot } from './shots';

/**
 * A screenshot in a drawn window frame — CSS only, no frame image to load.
 * The image is a plain <img> with its dimensions set, so the frame reserves
 * its space before the file arrives (next.config.ts serves images unoptimised).
 */
export function DeviceFrame({
  shot,
  alt,
  eager = false,
  className,
}: {
  shot: Shot;
  alt: string;
  /** The first screen's picture loads at once; every other one waits. */
  eager?: boolean;
  className?: string;
}) {
  return (
    <figure className={cn('sk-device-frame', className)}>
      <div aria-hidden="true" className="sk-device-frame__bar">
        <span />
        <span />
        <span />
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- a static file under public/marketing */}
      <img
        src={shot.src}
        alt={alt}
        width={shot.width}
        height={shot.height}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className="block h-auto w-full"
      />
    </figure>
  );
}
