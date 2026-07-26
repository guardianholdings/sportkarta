import { getTranslations } from 'next-intl/server';

import { routing } from '@/i18n/routing';
import { municipalityAccountability } from '@/lib/accountability';
import { cityDisplayName, getCityBySlug } from '@/lib/places';
import { siteUrl } from '@/lib/seo';
import { escapeHtml, renderWidget, type WidgetStrings } from '@/lib/widget';
import { widgetCached } from '@/lib/widget-cache';

/**
 * The embeddable, aggregate-only municipality widget (Stage 3.4).
 *
 * A ROUTE HANDLER, not a page, and deliberately so: pages under [locale]
 * inherit the site layout, which registers a service worker and — where
 * configured — loads Umami and GlitchTip. Embedding our widget must not make a
 * municipality's visitors subject to our telemetry, and there is no consent
 * banner inside an iframe. A route handler inherits nothing.
 *
 * It is also outside the i18n middleware's matcher (which skips /api), so the
 * response sets no cookie of any kind. The locale is an explicit `?lang=`
 * parameter, allowlisted against the configured locales: whoever writes the
 * embed snippet decides the language, not the visitor's browser.
 *
 * Two representations, one URL:
 *   ?format=json → the full aggregate payload, CORS-open (it is ODbL open data)
 *   otherwise    → a self-contained HTML document for an <iframe>
 *
 * The CSP is the enforcement of what lib/widget.ts promises: `script-src
 * 'none'` and `default-src 'none'` mean the document cannot execute or fetch
 * anything even if a future edit puts a <script> in it. `frame-ancestors *` is
 * the one place in this app where framing is allowed, which is why the global
 * deny lives in next.config.ts and this route overrides it explicitly rather
 * than the other way round.
 */

export const dynamic = 'force-dynamic';

const HTML_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  // The stylesheet is inline; there is no external CSS to allow.
  "style-src 'unsafe-inline'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  // The point of the widget.
  'frame-ancestors *',
].join('; ');

// Public, cacheable, and stale-servable: the numbers move on the scale of days,
// and a municipality's homepage must not go down because ours is redeploying.
const CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

function localeOf(request: Request): string {
  const requested = new URL(request.url).searchParams.get('lang');
  return routing.locales.includes(requested as (typeof routing.locales)[number])
    ? (requested as string)
    : routing.defaultLocale;
}

async function widgetStrings(locale: string): Promise<WidgetStrings> {
  const t = await getTranslations({ locale, namespace: 'Accountability' });
  return {
    title: t('widgetTitle'),
    total: t('statTotal'),
    per10k: t('statPer10k'),
    freeShare: t('statFreeShare'),
    openReports: t('statOpenReports'),
    medianResponse: t('statMedianResponse'),
    hours: t('unitHours'),
    days: t('unitDays'),
    na: t('na'),
    attribution: t('attribution'),
    more: t('widgetMore'),
    conditionHeading: t('conditionHeading'),
    conditionExcellent: t('conditionExcellent'),
    conditionGood: t('conditionGood'),
    conditionPoor: t('conditionPoor'),
    conditionUnusable: t('conditionUnusable'),
    conditionUnreported: t('conditionUnreported'),
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ city: string }> },
): Promise<Response> {
  const { city: slug } = await params;
  const city = await getCityBySlug(slug);
  if (!city) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const locale = localeOf(request);
  const wantsJson = new URL(request.url).searchParams.get('format') === 'json';

  // The micro-cache (lib/widget-cache.ts) is what makes the Cache-Control
  // below more than a wish — nothing else in the stack caches — and its
  // stale-while-error path is what keeps an embed alive through a deploy.
  const cached = await widgetCached(`acc:${city.slug}`, () => municipalityAccountability(city));
  if (!cached) {
    // Cold process AND the database is away: degrade politely, uncached, with
    // the same envelope guarantees as the healthy path.
    if (wantsJson) {
      return Response.json(
        { error: 'temporarily_unavailable' },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': '60',
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex',
          },
        },
      );
    }
    const t = await getTranslations({ locale, namespace: 'Accountability' });
    return new Response(
      `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${escapeHtml(t('widgetTitle'))}</title></head><body style="margin:0;padding:12px;font:14px/1.4 system-ui,sans-serif;color:#6b7280">${escapeHtml(t('widgetUnavailable'))}</body></html>`,
      {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Retry-After': '60',
          'Content-Security-Policy': HTML_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex',
        },
      },
    );
  }
  const { value: data, degraded } = cached;
  // A stale copy served through an outage must not be re-cached downstream
  // for an hour as if it were fresh.
  const cacheControl = degraded ? 'public, max-age=60' : CACHE;

  if (wantsJson) {
    return Response.json(data, {
      headers: {
        'Cache-Control': cacheControl,
        // Open data under ODbL: a municipality charting our figures on its own
        // site should not need a proxy to do it.
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        // Parity with the HTML variant: we learn nothing about who embeds us,
        // and a JSON URL in a dashboard should not leak its referrer either.
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  const base = siteUrl();
  const pagePath = locale === routing.defaultLocale ? '' : `/${locale}`;
  const html = renderWidget({
    data,
    cityName: cityDisplayName(city.nameBg, city.nameEn, locale),
    pageUrl: `${base}${pagePath}/obshtina/${city.slug}`,
    locale,
    strings: await widgetStrings(locale),
  });

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': cacheControl,
      'Content-Security-Policy': HTML_CSP,
      'X-Content-Type-Options': 'nosniff',
      // We learn nothing from who embeds us, and the embedding site should not
      // have to explain us in its own privacy policy.
      'Referrer-Policy': 'no-referrer',
      // The meta tag in the document says the same; the header covers the JSON
      // variant's parity and non-HTML consumers.
      'X-Robots-Tag': 'noindex',
    },
  });
}
