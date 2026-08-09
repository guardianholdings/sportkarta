import type { MunicipalityAccountability } from './accountability';

/**
 * The embeddable municipality widget (docs/ROADMAP.md §5, Stage 3.4).
 *
 * This file renders a COMPLETE HTML document as a string, and that is the
 * design, not a shortcut. The widget runs inside an iframe on somebody else's
 * domain — a municipal website, a newspaper, an NGO's page — and the things it
 * must not do there are easier to guarantee by construction than by review:
 *
 *  - NO JAVASCRIPT. Not our own, not a framework's hydration payload. The
 *    served CSP is `script-src 'none'`, so even a future accident cannot start
 *    executing on a third party's page.
 *  - NO COOKIES, NO ANALYTICS, NO EXTERNAL REQUESTS. Umami and GlitchTip live
 *    in the [locale] layout; the widget is a route handler precisely so it
 *    never inherits them. Embedding us must not make a municipality's visitors
 *    subject to our telemetry, and there is no consent banner in an iframe.
 *  - NO PERSONAL DATA, which is the type's problem rather than this file's:
 *    `MunicipalityAccountability` has no field that can hold a person (see
 *    lib/accountability.ts) and the shape test enforces it.
 *
 * Everything is inlined — styles, layout, colours — because there is nothing to
 * fetch. The only outbound link is back to the full page on our own site, and
 * ODbL attribution is rendered unconditionally: the widget carries the licence
 * with the data, which is the legal constant, not a nicety.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Every interpolated value goes through this. Most of them are numbers we
 * formatted ourselves, but the municipality name comes from the database and
 * the translated labels come from a JSON catalogue — both are exactly the kind
 * of value that is "obviously safe" right up until somebody edits the source.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export interface WidgetStrings {
  title: string;
  total: string;
  per10k: string;
  freeShare: string;
  openReports: string;
  medianResponse: string;
  hours: string;
  days: string;
  na: string;
  attribution: string;
  more: string;
  /** Condition-bar heading and its five segment labels, in order. */
  conditionHeading: string;
  conditionExcellent: string;
  conditionGood: string;
  conditionPoor: string;
  conditionUnusable: string;
  conditionUnreported: string;
}

export interface WidgetInput {
  data: MunicipalityAccountability;
  cityName: string;
  /** Absolute URL of the full accountability page. */
  pageUrl: string;
  locale: string;
  strings: WidgetStrings;
}

function share(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  return `${((part / whole) * 100).toFixed(0)}%`;
}

/** One headline figure. */
function stat(value: string, label: string): string {
  return `<div class="s"><div class="v">${escapeHtml(value)}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

/**
 * The condition bar: what the public last said about the facilities here.
 * A flex row of coloured segments sized by share — no script, no SVG, no chart
 * library.
 *
 * The aria-label spells out every segment with its count, because these five
 * numbers appear NOWHERE ELSE in the widget: a `role="img"` labelled only
 * "condition" would leave a screen-reader user with a bar they are told exists
 * and cannot read. Colour is never the only channel.
 */
function conditionBar(data: MunicipalityAccountability, strings: WidgetStrings): string {
  const segments: [number, string, string][] = [
    [data.conditionExcellent, '#0B7A40', strings.conditionExcellent],
    [data.conditionGood, '#0FA958', strings.conditionGood],
    [data.conditionPoor, '#DD7C21', strings.conditionPoor],
    [data.conditionUnusable, '#BB4333', strings.conditionUnusable],
    [data.conditionUnreported, '#CFC9BC', strings.conditionUnreported],
  ];
  const whole = segments.reduce((sum, [n]) => sum + n, 0);
  if (whole === 0) return '';
  const bars = segments
    .filter(([n]) => n > 0)
    .map(([n, colour]) => {
      const pct = ((n / whole) * 100).toFixed(2);
      return `<i style="flex:${pct} 0 0;background:${colour}"></i>`;
    })
    .join('');
  const label = `${strings.conditionHeading}: ${segments
    .map(([n, , text]) => `${text} ${String(n)}`)
    .join(', ')}`;
  return `<div class="bar" role="img" aria-label="${escapeHtml(label)}">${bars}</div>`;
}

export function renderWidget(input: WidgetInput): string {
  const { data, strings } = input;
  const per10k = data.per10k === null ? strings.na : data.per10k.toFixed(1);
  const freeShare = share(data.free, data.total) ?? strings.na;
  const median =
    data.reportsMedianHours === null
      ? strings.na
      : data.reportsMedianHours >= 48
        ? `${(data.reportsMedianHours / 24).toFixed(0)} ${strings.days}`
        : `${data.reportsMedianHours.toFixed(0)} ${strings.hours}`;

  // lang is the widget's own locale, so a screen reader on a Bulgarian
  // municipality's English page still pronounces these labels correctly.
  return `<!doctype html>
<html lang="${escapeHtml(input.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.cityName)} — ${escapeHtml(strings.title)}</title>
<style>
:root{color-scheme:light dark;--fg:#101418;--muted:#646A73;--line:#E3DFD4;--bg:#FEFDFB;--accent:#FF4A2B}
@media (prefers-color-scheme:dark){:root{--fg:#F5F3EE;--muted:#8A9099;--line:#313D49;--bg:#101418}}
*{box-sizing:border-box}
body{margin:0;padding:12px;background:var(--bg);color:var(--fg);border-top:3px solid var(--accent);
font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{margin:0 0 2px;font-size:15px;font-weight:600}
.sub{margin:0 0 10px;font-size:12px;color:var(--muted)}
.g{display:flex;flex-wrap:wrap;gap:8px}
.s{flex:1 1 96px;border:1px solid var(--line);border-radius:8px;padding:8px}
.v{font-size:20px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.l{font-size:11px;color:var(--muted);margin-top:2px}
.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:10px 0 0}
.bar i{display:block}
footer{margin-top:10px;padding-top:8px;border-top:1px solid var(--line);
font-size:11px;color:var(--muted)}
a{color:inherit}
</style>
</head>
<body>
<h1>${escapeHtml(input.cityName)}</h1>
<p class="sub">${escapeHtml(strings.title)}</p>
<div class="g">
${stat(String(data.total), strings.total)}
${stat(per10k, strings.per10k)}
${stat(freeShare, strings.freeShare)}
${stat(String(data.reportsOpen), strings.openReports)}
${stat(median, strings.medianResponse)}
</div>
${conditionBar(data, strings)}
<footer>
<a href="${escapeHtml(input.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(strings.more)}</a>
· ${escapeHtml(strings.attribution)}
</footer>
</body>
</html>
`;
}
