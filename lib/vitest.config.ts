import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * Vitest's default is 5 s, which is aimed at unit tests. This package is
     * where the fast-check property suites live — the DST transitions
     * discovered from the tz database, the badge streak folds, the RFC 5545
     * octet folding — and several of them legitimately run for a second or two
     * apiece. Run in parallel with the rest of the package on a loaded machine,
     * the slowest were landing within a whisker of 5 s and failing
     * intermittently, which is worse than no property test at all: it trains
     * everyone to re-run the suite instead of reading the failure.
     *
     * Raised rather than shrinking the properties, because the number of random
     * cases IS the value here. 30 s still catches anything that truly hangs,
     * and long before CI would.
     */
    testTimeout: 30_000,
  },
});
