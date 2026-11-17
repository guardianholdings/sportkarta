import { clubsEnabled } from '@/lib/clubs/access';
import { buildLlmsText, llmsResponse } from '@/lib/llms';

// Per request: see app/llms.txt/route.ts.
export const dynamic = 'force-dynamic';

/**
 * The English file, /en/llms.txt. Only `en` answers: a dotted path skips the
 * middleware, so nothing has checked the locale, and the Bulgarian file's one
 * address is /llms.txt — /bg/llms.txt would be a second copy of it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string }> },
): Promise<Response> {
  const { locale } = await params;
  if (locale !== 'en') return new Response('Not found', { status: 404 });
  return llmsResponse(await buildLlmsText('en', { clubs: clubsEnabled() }));
}
