export interface StoragePutOptions {
  contentType?: string;
}

export interface StorageObject {
  key: string;
  size: number;
  contentType?: string;
}

/**
 * Storage abstraction (docs/ROADMAP.md §0): a local Docker volume today, a
 * MinIO/S3 move later without touching call sites. Keys are forward-slash
 * paths relative to the volume root, e.g. "photos/2026/07/abc.webp".
 *
 * THERE IS DELIBERATELY NO PUBLIC URL. Nothing serves the volume directly —
 * no static mount, no Caddy file_server, no `public/` copy — and the adapter
 * offers no way to name one. Every file reaches a browser through a route that
 * looks up the ROW that points at it and decides from that row whether this
 * viewer may have it (/api/photos/[id], /api/partners/logo/[id],
 * /api/ads/creative/[id], the open-data dumps). A pending facility photo is on
 * this volume from the moment it is uploaded; a URL scheme derived from the key
 * would publish it, and every other unmoderated file, the day somebody mounted
 * the prefix it promised.
 */
export interface StorageAdapter {
  put(key: string, data: Uint8Array, options?: StoragePutOptions): Promise<StorageObject>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  /** Idempotent: deleting a key that is already gone is not an error. */
  delete(key: string): Promise<void>;
}
