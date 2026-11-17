import { clubsEnabled } from '@/lib/clubs/access';
import { buildLlmsText, llmsResponse } from '@/lib/llms';

// Per request, for the reason app/robots.ts gives: the image is built in CI
// with no NEXT_PUBLIC_SITE_URL, so a prerendered file would send a model to
// localhost. The clubs switch is runtime environment too.
export const dynamic = 'force-dynamic';

/** The Bulgarian file, at the root like every Bulgarian page (lib/llms.ts). */
export async function GET(): Promise<Response> {
  return llmsResponse(await buildLlmsText('bg', { clubs: clubsEnabled() }));
}
