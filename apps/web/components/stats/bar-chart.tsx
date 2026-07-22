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

export function BarChart({ title, bars, color = '#0f766e' }: BarChartProps) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const barMax = WIDTH - LABEL_W - VALUE_W;
  const height = Math.max(1, bars.length) * (ROW_H + GAP);
  const summary = `${title}: ${bars.map((b) => `${b.label} ${b.display}`).join(', ')}`;

  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium">{title}</figcaption>
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
              <text x={0} y={y + ROW_H / 2} dominantBaseline="central" fontSize="12" fill="#404040">
                {truncate(b.label)}
              </text>
              <rect x={LABEL_W} y={y} width={Math.max(1, w)} height={ROW_H} rx={3} fill={color} />
              <text
                x={LABEL_W + Math.max(1, w) + 6}
                y={y + ROW_H / 2}
                dominantBaseline="central"
                fontSize="12"
                fill="#404040"
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
