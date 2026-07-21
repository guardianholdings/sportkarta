import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { StorageAdapter, StorageObject, StoragePutOptions } from './adapter';

// Keys are validated before touching the filesystem: relative, ASCII-safe,
// no dot-segments — user-influenced names must never traverse the volume.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

export interface LocalVolumeStorageOptions {
  /** Directory backing the volume (STORAGE_DIR); resolved to an absolute path. */
  rootDir: string;
  /** URL prefix the web app serves files under. Default: "/uploads". */
  publicPrefix?: string;
}

export class LocalVolumeStorage implements StorageAdapter {
  private readonly rootDir: string;
  private readonly publicPrefix: string;

  constructor(options: LocalVolumeStorageOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.publicPrefix = options.publicPrefix ?? '/uploads';
  }

  async put(key: string, data: Uint8Array, options?: StoragePutOptions): Promise<StorageObject> {
    const filePath = this.resolvePath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return { key, size: data.byteLength, contentType: options?.contentType };
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolvePath(key)));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }

  publicUrl(key: string): string {
    this.assertValidKey(key);
    return `${this.publicPrefix}/${key}`;
  }

  private resolvePath(key: string): string {
    this.assertValidKey(key);
    const filePath = path.resolve(this.rootDir, key);
    if (!filePath.startsWith(this.rootDir + path.sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return filePath;
  }

  private assertValidKey(key: string): void {
    const hasDotSegment = key.split('/').some((segment) => segment === '.' || segment === '..');
    if (!KEY_PATTERN.test(key) || hasDotSegment) {
      throw new Error(`Invalid storage key: ${key}`);
    }
  }
}
