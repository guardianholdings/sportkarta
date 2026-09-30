import { describe, expect, it } from 'vitest';

import { buildReport, type ImportStats } from './report.js';

function stats(over: Partial<ImportStats['counts']> = {}, layerComplete = true): ImportStats {
  return {
    mode: 'dry-run',
    startedAt: new Date('2026-09-29T08:00:00Z'),
    extractMd5: 'abc',
    extractDownloaded: false,
    municipalities: {
      boundariesFound: 265,
      counts: { matched: 265, inserted: 0, updated: 0, unchanged: 265 },
      unmatched: [],
      missingFromOsm: [],
      layerComplete,
    },
    assignment: {
      changed: 1,
      outOfPolygon: 1,
      outSamples: [{ ref: 'node:7', slug: 'node-7', name: null, lon: 22.957, lat: 41.368 }],
    },
    featuresTotal: 10,
    skips: { lifecycle_abandoned: 2 },
    geometryTwins: 0,
    candidates: 8,
    counts: {
      inserted: 1,
      updated: 0,
      unchanged: 5,
      frozenFields: {},
      missingFromExtract: 0,
      constraintSkips: 0,
      withdrawn: 2,
      withdrawnKept: [{ ref: 'way:8', slug: 'basein', name: 'Басейн', status: 'active' }],
      restored: 0,
      duplicatesSkipped: [{ keep: 'way:2', drop: 'node:1', distanceM: 2.24 }],
      existingDuplicates: [{ keep: 'way:4', drop: 'node:3', distanceM: 1.5 }],
      outsideMunicipalities: [{ ref: 'node:9', name: 'Отвъд', lon: 26.198, lat: 41.442 }],
      ...over,
    },
    unmappedSports: {},
    unmappedSurfaces: {},
    unusualLit: {},
    noSportBuckets: {},
    bySport: [],
    byMunicipality: [],
    totalOsm: 6000,
  };
}

describe('buildReport — the dry-run gate shows every pre-launch fix', () => {
  it('lists withdrawals, duplicates and out-of-border rows for the operator', () => {
    const report = buildReport(stats());
    expect(report).toContain('| Withdrawn — OSM now marks abandoned/disused (status → gone) | 2 |');
    expect(report).toContain(
      '| Lifecycle-tagged but kept — a person or registry vouched for it | 1 |',
    );
    expect(report).toContain('| `way:8` | basein | Басейн | active |');
    expect(report).toContain('| `way:2` | `node:1` | 2.2 m |');
    expect(report).toContain('| `way:4` | `node:3` | 1.5 m |');
    expect(report).toContain('| `node:9` | Отвъд | 26.1980, 41.4420 |');
    expect(report).toContain('| `node:7` | node-7 | (без име) | 22.9570, 41.3680 |');
    expect(report).toContain('Border gate for new facilities: armed');
  });

  it('says plainly when the border gate is off', () => {
    expect(buildReport(stats({}, false))).toContain('Border gate for new facilities: NOT armed');
  });

  it('caps long lists but keeps the exact count', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      keep: `way:${String(i)}`,
      drop: `node:${String(i)}`,
      distanceM: 1,
    }));
    const report = buildReport(stats({ duplicatesSkipped: many }));
    expect(report).toContain(
      '| Not inserted — duplicates a row within 5 m (other element type, shared sport) | 60 |',
    );
    expect(report).toContain('| … | 10 more | |');
  });
});
