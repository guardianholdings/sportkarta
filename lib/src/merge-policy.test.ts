import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canOverwrite,
  jsonEquals,
  mergeFields,
  SOURCE_PRIORITY,
  type EditSource,
  type JsonValue,
  type MergeInput,
} from './merge-policy.js';

const sourceArb = fc.constantFrom<EditSource>('osm', 'municipal', 'crowd');
const maybeSourceArb = fc.option(sourceArb, { nil: undefined });

const jsonArb: fc.Arbitrary<JsonValue> = fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<JsonValue>;

const FIELDS = ['name', 'sport_types', 'surface', 'lighting', 'covered', 'access', 'geom'] as const;

const mergeInputArb: fc.Arbitrary<MergeInput> = fc.record({
  incomingSource: sourceArb,
  current: fc.dictionary(fc.constantFrom(...FIELDS), jsonArb),
  incoming: fc.dictionary(fc.constantFrom(...FIELDS), jsonArb),
  lastEditSources: fc.dictionary(fc.constantFrom(...FIELDS), maybeSourceArb),
});

describe('canOverwrite', () => {
  it('never-edited fields are always writable; equal priority may revise itself', () => {
    fc.assert(
      fc.property(sourceArb, (s) => {
        expect(canOverwrite(s, undefined)).toBe(true);
        expect(canOverwrite(s, s)).toBe(true);
      }),
    );
  });

  it('is exactly priority comparison', () => {
    fc.assert(
      fc.property(sourceArb, sourceArb, (incoming, last) => {
        expect(canOverwrite(incoming, last)).toBe(
          SOURCE_PRIORITY[incoming] >= SOURCE_PRIORITY[last],
        );
      }),
    );
  });

  it('crowd overwrites everything; osm never overwrites crowd or municipal', () => {
    for (const s of ['osm', 'municipal', 'crowd'] as const) {
      expect(canOverwrite('crowd', s)).toBe(true);
    }
    expect(canOverwrite('osm', 'crowd')).toBe(false);
    expect(canOverwrite('osm', 'municipal')).toBe(false);
    expect(canOverwrite('municipal', 'crowd')).toBe(false);
    expect(canOverwrite('municipal', 'osm')).toBe(true);
  });
});

describe('mergeFields properties', () => {
  it('partitions incoming fields exactly into applied / frozen / unchanged', () => {
    fc.assert(
      fc.property(mergeInputArb, (input) => {
        const r = mergeFields(input);
        const all = [...r.applied.map((c) => c.field), ...r.frozen, ...r.unchanged].sort();
        expect(all).toEqual(Object.keys(input.incoming).sort());
      }),
    );
  });

  it('a field last edited by a higher-priority source is never applied', () => {
    fc.assert(
      fc.property(mergeInputArb, (input) => {
        const r = mergeFields(input);
        for (const change of r.applied) {
          const last = input.lastEditSources[change.field];
          if (last !== undefined) {
            expect(SOURCE_PRIORITY[input.incomingSource]).toBeGreaterThanOrEqual(
              SOURCE_PRIORITY[last],
            );
          }
        }
      }),
    );
  });

  it('applied changes always carry a real difference (audit rows are never no-ops)', () => {
    fc.assert(
      fc.property(mergeInputArb, (input) => {
        for (const change of mergeFields(input).applied) {
          expect(jsonEquals(change.oldValue, change.newValue)).toBe(false);
        }
      }),
    );
  });

  it('is idempotent: re-merging after applying yields zero applied changes', () => {
    fc.assert(
      fc.property(mergeInputArb, (input) => {
        const first = mergeFields(input);
        const nextCurrent = { ...input.current };
        const nextLast = { ...input.lastEditSources };
        for (const change of first.applied) {
          nextCurrent[change.field] = change.newValue;
          nextLast[change.field] = input.incomingSource;
        }
        const second = mergeFields({ ...input, current: nextCurrent, lastEditSources: nextLast });
        expect(second.applied).toEqual([]);
      }),
    );
  });

  it('an osm import never touches a crowd-frozen differing field', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...FIELDS), jsonArb, { minKeys: 1 }),
        (incoming) => {
          const current = Object.fromEntries(Object.keys(incoming).map((f) => [f, '__crowd__']));
          const lastEditSources = Object.fromEntries(
            Object.keys(incoming).map((f) => [f, 'crowd' as const]),
          );
          const r = mergeFields({ incomingSource: 'osm', current, incoming, lastEditSources });
          expect(r.applied).toEqual([]);
        },
      ),
    );
  });
});

describe('jsonEquals', () => {
  it('is reflexive for arbitrary JSON', () => {
    fc.assert(
      fc.property(jsonArb, (v) => {
        expect(jsonEquals(v, v)).toBe(true);
      }),
    );
  });

  it('is key-order insensitive but array-order sensitive', () => {
    expect(jsonEquals({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
  });
});
