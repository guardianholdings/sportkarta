import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load the root .env so DATABASE_URL reaches the DB-backed tests; in
// environments without a database the tests skip themselves.
config({ path: '../.env' });

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Every suite here is an integration test against the ONE dev database.
    // Run in parallel they interfere: one file's cleanup deletes another's
    // fixtures mid-test, and a whole-table scan (the materializer's) picks up
    // rows a different suite is still using. The suite takes a few seconds, so
    // serialising is cheap next to chasing the flakes.
    fileParallelism: false,
  },
});
