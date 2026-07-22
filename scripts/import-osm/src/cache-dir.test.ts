import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCacheDir } from './cache-dir.js';

const DEFAULT = path.join(os.tmpdir(), 'sportkarta-osm-cache');

describe('resolveCacheDir', () => {
  const original = process.env.OSM_CACHE_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.OSM_CACHE_DIR;
    else process.env.OSM_CACHE_DIR = original;
  });

  it('uses the tmpdir default when nothing is set', () => {
    delete process.env.OSM_CACHE_DIR;
    expect(resolveCacheDir()).toBe(DEFAULT);
  });

  it('prefers an explicit option over env and default', () => {
    process.env.OSM_CACHE_DIR = '/env/path';
    expect(resolveCacheDir('/explicit')).toBe('/explicit');
  });

  it('uses OSM_CACHE_DIR when set', () => {
    process.env.OSM_CACHE_DIR = '/data/osm-cache';
    expect(resolveCacheDir()).toBe('/data/osm-cache');
  });

  it('trims surrounding whitespace on the env value', () => {
    process.env.OSM_CACHE_DIR = '  /data/osm  ';
    expect(resolveCacheDir()).toBe('/data/osm');
  });

  it('falls back to the default for a blank/whitespace env value', () => {
    process.env.OSM_CACHE_DIR = '   ';
    expect(resolveCacheDir()).toBe(DEFAULT);
  });
});
