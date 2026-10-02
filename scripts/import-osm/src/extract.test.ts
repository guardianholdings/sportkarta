import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectCandidates } from './extract.js';

// What `osmium export -f geojsonseq -u type_id` writes: RS + JSON + LF.
function seq(features: object[]): string {
  return features.map((f) => `\u001e${JSON.stringify(f)}\n`).join('');
}

const point = { type: 'Point', coordinates: [23.32, 42.7] };
const square = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [23.32, 42.7],
        [23.321, 42.7],
        [23.321, 42.701],
        [23.32, 42.7],
      ],
    ],
  ],
};
const ring = { type: 'LineString', coordinates: square.coordinates[0]?.[0] };

describe('collectCandidates', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sportkarta-extract-test-'));
    file = path.join(dir, 'features.geojsonseq');
    await writeFile(
      file,
      seq([
        {
          type: 'Feature',
          id: 'n1',
          properties: { leisure: 'pitch', sport: 'soccer' },
          geometry: point,
        },
        // A closed way osmium emits twice (area "a" id + perimeter "w" id),
        // both abandoned: one withdrawn object, counted once.
        {
          type: 'Feature',
          id: 'a4',
          properties: { leisure: 'pitch', sport: 'tennis', abandoned: 'yes' },
          geometry: square,
        },
        {
          type: 'Feature',
          id: 'w2',
          properties: { leisure: 'pitch', sport: 'tennis', abandoned: 'yes' },
          geometry: ring,
        },
        {
          type: 'Feature',
          id: 'n3',
          properties: { 'disused:leisure': 'fitness_station', sport: 'fitness' },
          geometry: point,
        },
      ]),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps withdrawn refs apart from candidates, once per object', async () => {
    const c = await collectCandidates(file);
    expect(c.featuresTotal).toBe(4);
    expect([...c.byKey.keys()]).toEqual(['node:1']);
    expect([...c.withdrawn].sort()).toEqual(['node:3', 'way:2']);
    expect(c.skips).toEqual({ lifecycle_abandoned: 1, lifecycle_disused: 1 });
  });
});
