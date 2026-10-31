import { clubHasFeature } from '@sportkarta/lib/clubs';
import { getTranslations } from 'next-intl/server';

import { routing } from '@/i18n/routing';
import { clubsEnabled } from '@/lib/clubs/access';
import { publicClub } from '@/lib/clubs/public';
import { renderClubWidget, type ClubWidgetKind } from '@/lib/clubs/widget';
import { siteUrl } from '@/lib/seo';

/**
 * A club's embeddable timetable or price list (0045; tier feature `embeds`).
 *
 * A route handler for the municipal widget's reasons
 * (app/api/widget/obshtina/[city]/route.ts): it inherits no layout, so no
 * service worker, analytics or error monitor rides into the club's website,
 * and it is outside the i18n middleware, so it sets no cookie. The same CSP —
 * no script, no fetch, framing allowed anywhere — enforces it. A club that is
 * hidden, suspended, lapsed or on a tier without embeds gets a 404, exactly as
 * its public page does.
 */

export const dynamic = 'force-dynamic';

const HTML_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  'frame-ancestors *',
].join('; ');

const KINDS: readonly ClubWidgetKind[] = ['grafik', 'ceni'];

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; kind: string }> },
): Promise<Response> {
  if (!clubsEnabled()) return notFound();
  const { slug, kind } = await params;
  if (!(KINDS as readonly string[]).includes(kind)) return notFound();
  const requested = new URL(request.url).searchParams.get('lang');
  const locale = routing.locales.includes(requested as (typeof routing.locales)[number])
    ? (requested as string)
    : routing.defaultLocale;
  const club = await publicClub(slug, locale);
  if (!club || !clubHasFeature(club.tier, 'embeds')) return notFound();

  const t = await getTranslations({ locale, namespace: 'ClubPublic' });
  const pagePath = locale === routing.defaultLocale ? '' : `/${locale}`;
  const html = renderClubWidget({
    kind: kind as ClubWidgetKind,
    locale,
    clubName: club.name,
    pageUrl: `${siteUrl()}${pagePath}/klub/${club.slug}`,
    classes: club.classes,
    plans: club.plans,
    strings: {
      title: kind === 'grafik' ? t('classesTitle') : t('plansTitle'),
      empty: kind === 'grafik' ? t('noClasses') : t('noPlans'),
      spots: (going, capacity) =>
        capacity === null ? t('spotsOpen', { going }) : t('spots', { going, capacity }),
      full: t('full'),
      book: t('widgetBook'),
      more: t('widgetMore'),
      validity: (plan) =>
        (plan.validityMonths
          ? t('validityMonths', { count: plan.validityMonths })
          : t('validityDays', { count: plan.validityDays ?? 1 })) +
        (plan.visitsCount ? ` · ${t('visits', { count: plan.visitsCount })}` : ''),
      poweredBy: t('widgetPoweredBy'),
    },
  });
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // A short cache: a timetable's spots move during the day.
      'Cache-Control': 'public, max-age=120, stale-while-revalidate=600',
      'Content-Security-Policy': HTML_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    },
  });
}
