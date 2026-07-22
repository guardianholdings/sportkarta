import { LocalVolumeStorage, type StorageAdapter } from '@sportkarta/lib/storage';

// Single web-app storage adapter over the local volume (STORAGE_DIR). The
// interface is swap-ready for MinIO/S3 later (docs/ROADMAP.md §0) without
// touching call sites. Server-only — never import from a client component.
let instance: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (instance) return instance;
  const rootDir = process.env.STORAGE_DIR;
  if (!rootDir) {
    throw new Error('STORAGE_DIR is required for file uploads (see .env.example)');
  }
  instance = new LocalVolumeStorage({ rootDir });
  return instance;
}
