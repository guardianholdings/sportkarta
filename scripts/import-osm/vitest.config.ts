import { defineConfig } from 'vitest/config';

// Mapping/normalization tests are pure — no database, no network, no osmium.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
