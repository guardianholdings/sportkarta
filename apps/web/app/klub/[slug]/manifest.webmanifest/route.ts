import { getDb, sql } from '@sportkarta/db';

import rootManifest from '@/app/manifest';
import { clubRenderableSql, clubsEnabled } from '@/lib/clubs/access';

/**
 * A club's own installable app (0051, wave F — 1club's €99 "branded app",
 * here at no charge): the same POPS web app, but installed under the club's
 * name, opening on the club's portal and staying inside the club's pages.
 * Push notifications, the QR and bookings all work from it.
 *
 * Outside [locale] on purpose: middleware skips any path with a dot, so this
 * URL reaches the router as written. The row decides (public only while the
 * club is RENDERABLE — the public page's own predicate); a hidden or lapsed
 * club has no app to install. The colours are the root manifest's — one
 * source for the brand paper and the mark's coral.
 */
export const dynamic = 'force-dynamic';

const SLUG = /^[a-z0-9-]{3,60}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  if (!clubsEnabled()) return new Response(null, { status: 404 });
  const { slug } = await params;
  if (!SLUG.test(slug)) return new Response(null, { status: 404 });
  const result = await getDb().execute(sql`
    SELECT c.id, c.slug, c.locale, c.name_bg, c.name_en, c.logo_path IS NOT NULL AS has_logo
      FROM clubs c
     WHERE c.slug = ${slug} AND ${clubRenderableSql('c')}
  `);
  const row = result.rows[0];
  if (!row) return new Response(null, { status: 404 });
  const en = row.locale === 'en';
  const name = String((en ? row.name_en : null) ?? row.name_bg);
  const base = `${en ? '/en' : ''}/klub/${String(row.slug)}`;
  const root = rootManifest();
  const manifest = {
    id: `${base}/`,
    name,
    short_name: name.length > 12 ? `${name.slice(0, 11)}…` : name,
    lang: en ? 'en' : 'bg',
    dir: 'ltr',
    start_url: `${base}/az`,
    scope: `${base}/`,
    display: 'standalone',
    background_color: root.background_color,
    theme_color: root.theme_color,
    icons: [
      ...(row.has_logo === true
        ? [{ src: `/api/clubs/logo/${String(row.id)}`, sizes: 'any', purpose: 'any' }]
        : []),
      ...(root.icons ?? []),
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
