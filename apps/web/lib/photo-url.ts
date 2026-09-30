/**
 * The ONE way a page names a facility photo: by its row id, through the route
 * that decides who may see it (app/api/photos/[id]/route.ts, rules in
 * lib/photos.ts). Never a storage key — keys are internal, and nothing serves
 * the volume by path (lib/src/storage/adapter.ts).
 *
 * No imports, so client components (the map's in-sheet facility drill) can use
 * it without pulling a database driver into the browser bundle.
 */
export function photoUrl(photoId: string): string {
  return `/api/photos/${encodeURIComponent(photoId)}`;
}
