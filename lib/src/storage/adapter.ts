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
 */
export interface StorageAdapter {
  put(key: string, data: Uint8Array, options?: StoragePutOptions): Promise<StorageObject>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** URL path the web app serves this object under. */
  publicUrl(key: string): string;
}
