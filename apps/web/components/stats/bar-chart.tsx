import { Link } from '@/i18n/navigation';

// Server-rendered horizontal bar chart — no client JS, no chart library (keeps
// the page fast + the launch Lighthouse gate happy).
//
// HTML ROWS, NOT AN SVG. It was an inline SVG whose 12px labels were drawn in
// a 560-unit viewBox and scaled with it: at 390px the text came out at about
// 7.7px, and the whole chart was one `role="img"` with its figures in an
// aria-label. As rows, the label and the value are ordinary text at the type
// scale (never below 12px), a screen reader reads them row by row, and a
// municipality's label can link to its /obshtina page. Only the bar itself is
// decoration.

export interface Bar {
  label: string;
  value: number;
  /** Pre-formatted value shown after the bar («13,58», «90,6%»). */
  display: string;
  /** Where the label leads — a municipality's /obshtina page — when known. */
  href?: string;
}

interface BarChartProps {
  title: string;
  bars: Bar[];
  /** Shown instead of a blank chart when there are no bars; defaults to an em dash. */
  emptyLabel?: string;
  /**
   * Bar fill. Pass a design token (`var(--brand)`, `var(--accent)`,
   * `var(--sky-500)`) so charts stay on the palette instead of carrying their
   * own hexes. The previous default was the pre-seed shadcn teal, which is what
   * RECONCILIATION C6 retired.
   */
  color?: string;
}

export function BarChart({ title, bars, color = 'var(--brand)', emptyLabel }: BarChartProps) {
  if (bars.length === 0) {
    // A caption over an empty chart reads as a rendering bug; say "no data".
    return (
      <figure className="space-y-2">
        <figcaption className="text-body-sm font-medium text-ink">{title}</figcaption>
        <p className="text-body-sm text-text-muted">{emptyLabel ?? '—'}</p>
      </figure>
    );
  }

  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <figure className="space-y-2">
      <figcaption className="text-body-sm font-medium text-ink">{title}</figcaption>
      <ul className="space-y-1">
        {bars.map((b, i) => {
          // Share of the longest bar; a non-zero value never vanishes entirely.
          const width = b.value > 0 ? Math.max(0.5, (b.value / max) * 100) : 0;
          return (
            // Index key: labels aren't guaranteed unique and bars never reorder.
            // Fixed label and value columns, so every row's track is the same
            // width and the bars compare honestly.
            <li
              key={i}
              className="grid min-h-8 grid-cols-[8.5rem_minmax(0,1fr)_4.5rem] items-center gap-x-2 text-caption"
            >
              {b.href ? (
                // A link is a control: 44px tall, like every other tap target.
                <Link
                  href={b.href}
                  className="inline-flex min-h-11 min-w-0 items-center font-medium text-link hover:text-link-hover"
                >
                  <span className="truncate">{b.label}</span>
                </Link>
              ) : (
                <span className="truncate text-ink-soft">{b.label}</span>
              )}
              <span aria-hidden className="block h-4">
                <span
                  className="block h-full rounded-xs"
                  style={{ width: `${String(width)}%`, background: color }}
                />
              </span>
              <span className="text-right font-mono text-ink-soft tabular-nums">{b.display}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
