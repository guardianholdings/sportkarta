import { formatEuro } from '@sportkarta/lib/clubs';

import { formatDateTime } from '../format';
import { WIDGET_PALETTE_CSS, escapeHtml } from '../widget';

import type { PortalClass } from './portal';
import type { PublicPlan } from './public';

/**
 * A club's embeddable widgets (0045; tier feature `embeds`) — its week's
 * timetable or its prices, inside an iframe on the club's OWN website. 1club
 * sells a "branded website" and anolla a "website booking button"; this is
 * the POPS answer that keeps the municipal widget's guarantees (lib/widget.ts
 * argues them): a complete HTML document as a string, NO JavaScript (the
 * route serves `script-src 'none'`), no cookies, no analytics, no request
 * anywhere. Every link opens the club's page on pops.bg in a new tab — the
 * booking itself happens there, signed in, never inside a third party's frame.
 *
 * Nothing personal can appear: the timetable carries counts, never a name.
 */

export type ClubWidgetKind = 'grafik' | 'ceni';

export interface ClubWidgetStrings {
  title: string;
  empty: string;
  /** Pre-translated (ICU plurals live in the caller's translator). */
  spots: (going: number, capacity: number | null) => string;
  full: string;
  book: string;
  more: string;
  validity: (plan: PublicPlan) => string;
  poweredBy: string;
}

export interface ClubWidgetInput {
  kind: ClubWidgetKind;
  locale: string;
  clubName: string;
  pageUrl: string;
  classes: PortalClass[];
  plans: PublicPlan[];
  strings: ClubWidgetStrings;
}

function link(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
}

export function renderClubWidget(input: ClubWidgetInput): string {
  const { strings, locale } = input;
  let body: string;
  if (input.kind === 'grafik') {
    body =
      input.classes.length === 0
        ? `<p class="m">${escapeHtml(strings.empty)}</p>`
        : `<ul>${input.classes
            .map((c) => {
              const full = c.capacity !== null && c.going >= c.capacity;
              const spots = full ? strings.full : strings.spots(c.going, c.capacity);
              return `<li><span><b>${escapeHtml(c.title)}</b><br><span class="m">${escapeHtml(
                formatDateTime(c.startsAt, locale),
              )} · ${escapeHtml(c.locationName)}</span></span><span class="r">${escapeHtml(
                spots,
              )}<br>${link(`${input.pageUrl}/trenirovka/${c.occurrenceId}`, strings.book)}</span></li>`;
            })
            .join('')}</ul>`;
  } else {
    body =
      input.plans.length === 0
        ? `<p class="m">${escapeHtml(strings.empty)}</p>`
        : `<ul>${input.plans
            .map((p) => {
              return `<li><span><b>${escapeHtml(p.name)}</b><br><span class="m">${escapeHtml(
                strings.validity(p),
              )}</span></span><span class="r"><b>${escapeHtml(
                formatEuro(p.priceCents, locale),
              )}</b></span></li>`;
            })
            .join('')}</ul>`;
  }
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.clubName)} — ${escapeHtml(strings.title)}</title>
<style>
${WIDGET_PALETTE_CSS}
*{box-sizing:border-box}
body{margin:0;padding:12px;background:var(--bg);color:var(--fg);border-top:3px solid var(--accent);
font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{margin:0 0 8px;font-size:15px;font-weight:600}
ul{list-style:none;margin:0;padding:0}
li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
.m{color:var(--muted);font-size:12px}
.r{text-align:right;white-space:nowrap;font-size:12px}
a{color:var(--accent);font-weight:600}
footer{margin-top:10px;padding-top:8px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);
display:flex;justify-content:space-between;gap:8px}
</style>
</head>
<body>
<h1>${escapeHtml(input.clubName)} · ${escapeHtml(strings.title)}</h1>
${body}
<footer><span>${escapeHtml(strings.poweredBy)}</span>${link(input.pageUrl, strings.more)}</footer>
</body>
</html>`;
}
