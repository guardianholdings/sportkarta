import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalVolumeStorage } from './local.js';

describe('LocalVolumeStorage', () => {
  let rootDir: string;
  let storage: LocalVolumeStorage;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'sportkarta-storage-'));
    storage = new LocalVolumeStorage({ rootDir });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('round-trips an object through put/get/exists/delete', async () => {
    const key = 'photos/2026/test.txt';
    const data = new TextEncoder().encode('hello sportkarta');

    const stored = await storage.put(key, data, { contentType: 'text/plain' });
    expect(stored).toEqual({ key, size: data.byteLength, contentType: 'text/plain' });

    expect(await storage.exists(key)).toBe(true);
    expect(new TextDecoder().decode(await storage.get(key))).toBe('hello sportkarta');

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it('rejects path-traversal and malformed keys', async () => {
    const data = new Uint8Array([1]);

    await expect(storage.put('../evil.txt', data)).rejects.toThrow('Invalid storage key');
    await expect(storage.put('/etc/passwd', data)).rejects.toThrow('Invalid storage key');
    await expect(storage.put('a/../../evil.txt', data)).rejects.toThrow('Invalid storage key');
    expect(() => storage.publicUrl('..')).toThrow('Invalid storage key');
  });

  it('builds public URLs under the configured prefix', () => {
    expect(storage.publicUrl('photos/x.webp')).toBe('/uploads/photos/x.webp');
  });
});
