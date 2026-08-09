// Server-rendered inline-SVG horizontal bar chart — no client JS, no chart
// library (keeps the page fast + the launch Lighthouse gate happy). The same
// figures appear in the accessible table below, so this is a supplementary
// visualization (role="img" + summary label).

export interface Bar {
  label: string;
  value: number;
  /** Pre-formatted value shown at the end of the bar (e.g. "13.58", "90.6%"). */
  display: string;
}

interface BarChartProps {
  title: string;
  bars: Bar[];
  /** Shown instead of a blank chart when there are no bars; defaults to an em dash. */
  emptyLabel?: string;
  /**
   * Bar fill. Pass a design token (`var(--brand)`, `var(--accent)`,
   * `var(--sky-500)`) — an inline SVG resolves custom properties from the
   * document, so charts stay on the palette instead of carrying their own
   * hexes. The previous default was the pre-seed shadcn teal, which is what
   * RECONCILIATION C6 retired.
   */
  color?: string;
}

const WIDTH = 560;
const ROW_H = 26;
const GAP = 8;
const LABEL_W = 150;
const VALUE_W = 70;

function truncate(text: string, max = 20): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function BarChart({ title, bars, color = 'var(--brand)', emptyLabel }: BarChartProps) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const barMax = WIDTH - LABEL_W - VALUE_W;
  const height = Math.max(1, bars.length) * (ROW_H + GAP);
  const summary = `${title}: ${bars.map((b) => `${b.label} ${b.display}`).join(', ')}`;

  if (bars.length === 0) {
    // A caption over a blank SVG reads as a rendering bug; say "no data".
    return (
      <figure className="space-y-2">
        <figcaption className="text-body-sm font-medium text-ink">{title}</figcaption>
        <p className="text-body-sm text-text-muted">{emptyLabel ?? '\u2014'}</p>
      </figure>
    );
  }

  return (
    <figure className="space-y-2">
      <figcaption className="text-body-sm font-medium text-ink">{title}</figcaption>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(height)}`}
        role="img"
        aria-label={summary}
        className="w-full"
        style={{ maxHeight: `${String(height)}px` }}
      >
        {bars.map((b, i) => {
          const y = i * (ROW_H + GAP);
          const w = (b.value / max) * barMax;
          return (
            // Index key: labels aren't guaranteed unique and bars never reorder.
            <g key={i}>
              <text x={0} y={y + ROW_H / 2} dominantBaseline="central" fontSize="12" fill="var(--ink-soft)">
                {truncate(b.label)}
              </text>
              <rect x={LABEL_W} y={y} width={Math.max(1, w)} height={ROW_H} rx={3} fill={color} />
              <text
                x={LABEL_W + Math.max(1, w) + 6}
                y={y + ROW_H / 2}
                dominantBaseline="central"
                fontSize="12"
                fontFamily="var(--font-mono)"
                fill="var(--ink-soft)"
              >
                {b.display}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
