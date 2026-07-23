import type { SVGProps } from 'react';

/**
 * Custom activity glyphs — drawn to the seed's icon contract because Lucide has
 * no faithful equivalent (RECONCILIATION.md §3.4). Single 1.75 stroke, rounded
 * joins, 24-unit box, `currentColor`, no fill — visually interchangeable with a
 * Lucide line icon. Approved scope: one shared racket glyph (covers all four
 * racket sports) plus hockey and skateboard.
 *
 * Stroke width is NOT set here; it is pinned app-wide to 1.75 by a single CSS
 * rule in globals.css (`svg.app-glyph`, alongside `svg.lucide`), so every icon —
 * Lucide or custom — carries one weight regardless of how it is rendered.
 */

type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  /** Box size in px; matches Lucide's `size` prop. @default 24 */
  size?: number | string;
};

function Glyph({ size = 24, className, ...rest }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={['app-glyph', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      {...rest}
    />
  );
}

/** Racket + net sports (tennis · table_tennis · badminton · squash). */
export function RacketGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <ellipse cx="9" cy="8.5" rx="5.5" ry="6.5" />
      <path d="M5.2 8.5h7.6M9 2.4v11.2" />
      <path d="M12.7 13.1 19.4 19.8" />
      <path d="M17.8 18.2 20 20.4" />
    </Glyph>
  );
}

/** Ice hockey (stick + puck). */
export function HockeyGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M7 3v10l7 5" />
      <circle cx="18.6" cy="18.6" r="1.6" />
    </Glyph>
  );
}

/** Skateboard (deck + trucks + wheels). */
export function SkateboardGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3 11q9 3 18 0" />
      <path d="M8 13.6v.8M16 13.6v.8" />
      <circle cx="8" cy="15.4" r="1.5" />
      <circle cx="16" cy="15.4" r="1.5" />
    </Glyph>
  );
}
