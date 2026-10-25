import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * A number that rolls into place, digit by digit, like a stadium scoreboard.
 *
 * Pure CSS: each digit is a 0–9 strip in a one-line window, rendered already
 * at its final offset and animated FROM zero (`sk-odo-roll`), so the server's
 * HTML shows the right number with no JavaScript and reduced motion simply
 * lands on it (design-tokens/motion.css). Remount it — a new `key` — to roll
 * again. Screen readers get the plain number once; the strips are hidden.
 *
 * No hooks, so the server hero and the client sport filter share it.
 */
export function Odometer({
  value,
  locale,
  className,
}: {
  value: number;
  locale: string;
  className?: string;
}) {
  // The locale's own grouping, as everywhere else on the site: Bulgarian
  // leaves a four-digit number whole (5989) and groups from five (12 345).
  const text = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'bg-BG').format(value);
  let place = 0;
  return (
    <span className={cn('sk-odo', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="sk-odo__face">
        {[...text].map((char, index) => {
          if (!/\d/.test(char)) {
            return (
              <span key={index} className="sk-odo__sep">
                {char}
              </span>
            );
          }
          const style = { '--v': Number(char), '--p': place++ } as CSSProperties;
          return (
            <span key={index} className="sk-odo__digit" style={style}>
              <span className="sk-odo__strip">
                {DIGITS.map((digit) => (
                  <span key={digit}>{digit}</span>
                ))}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
