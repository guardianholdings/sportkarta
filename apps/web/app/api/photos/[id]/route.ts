import { getDb } from '@sportkarta/db';

import { getCurrentUser } from '@/lib/auth-session';
import type { ModerationActor } from '@/lib/moderation';
import { photoResponseHeaders, resolveServablePhoto } from '@/lib/photos';
import { getStorage } from '@/lib/storage';

/**
 * Serve a facility photo. THE ROW DECIDES, NOT THE PATH — who may have which
 * photo is written once, in lib/photos.ts; this handler only wires it to the
 * session and the storage adapter. Approved photos of public facilities go to
 * anyone; pending and rejected ones only to a moderator whose scope covers the
 * facility, which is how the moderation queue shows the image it is deciding.
 *
 * This is the ONLY way a stored photo reaches a browser. There is no /uploads
 * mount, and there must never be one: every upload sits on the volume from the
 * moment it arrives, unmoderated, and a path-based mount would publish all of
 * it at once.
 *
 * Nothing is logged: a photo request says which facility somebody looked at.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const photo = await resolveServablePhoto(getDb(), id, currentModerator);
  if (!photo) return notFound();

  try {
    const data = await getStorage().get(photo.storagePath);
    return new Response(new Uint8Array(data), { headers: photoResponseHeaders(photo.audience) });
  } catch {
    // A row pointing at a missing file (a refused photo whose file is already
    // gone, or an ops problem) is not a 500 a public page should wear.
    return notFound();
  }
}

/**
 * The viewer, read from the database like every other authorization decision
 * (never from the session cookie cache). Deliberately NOT requireAdmin(): an
 * image request that is refused gets a 404, not a redirect to the sign-in page.
 */
async function currentModerator(): Promise<ModerationActor | null> {
  const user = await getCurrentUser();
  return user ? { id: user.id, role: user.role } : null;
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
