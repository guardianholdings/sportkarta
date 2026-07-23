import { requireRole } from '@/lib/auth-session';
import {
  buildGrantReport,
  grantCsv,
  grantHtml,
  parseGrantScope,
  ReportScopeError,
} from '@/lib/reports';

/**
 * Downloading a grant annex (Stage 6.2).
 *
 * A ROUTE HANDLER rather than a page, for the same reason the widget is one in
 * 3.4: this response is a FILE. It needs `Content-Disposition`, a Bulgarian
 * filename and a content type, none of which a page can set.
 *
 * IT GATES ITSELF. Paths under /api are outside the middleware matcher, so the
 * optimistic cookie check never runs here — `requireRole('admin')` is the only
 * thing between a signed-out request and a municipality's participation
 * figures, and it reads the role from the database rather than from the session
 * cookie cache. Ambassadors are deliberately excluded: an annex is the
 * сдружение's own grant accounting, not a moderation tool.
 *
 * NEVER CACHED, PUBLICLY OR OTHERWISE. The figures are admin-visible aggregates
 * about people's participation; a shared cache holding one municipality's annex
 * and serving it to the next request is the whole risk in one line.
 *
 * NO PDF IS PRODUCED HERE, and that is a deliberate limit rather than an
 * omission: server-side PDF means bundling Chromium into the production image —
 * several hundred megabytes and a memory spike on a €15–25/month VPS — to save
 * a Ctrl+P. The HTML is print-ready (A4 `@page`, page-break rules), so the
 * browser's own print dialog produces the file; `pnpm report:grant` renders the
 * identical document to PDF from the same renderer when one is needed
 * unattended.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  await requireRole('admin');

  const params = new URL(request.url).searchParams;
  const format = params.get('format') === 'html' ? 'html' : 'csv';

  let scope;
  try {
    scope = parseGrantScope(params);
  } catch (error) {
    if (error instanceof ReportScopeError) {
      // The code, not a sentence: the admin page renders it through the i18n
      // catalogue, and this endpoint is reached by a form on that page.
      return Response.json({ error: error.code }, { status: 400 });
    }
    throw error;
  }

  const data = await buildGrantReport(scope);
  const rendered = format === 'html' ? grantHtml(data) : grantCsv(data);

  return new Response(rendered.body, {
    headers: {
      'Content-Type':
        format === 'html' ? 'text/html; charset=utf-8' : 'text/csv; charset=utf-8',
      // `inline` for HTML so the operator can read it and print it; `attachment`
      // for CSV, which no browser renders usefully.
      'Content-Disposition': `${format === 'html' ? 'inline' : 'attachment'}; filename="${rendered.filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
