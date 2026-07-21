import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load the root .env so DATABASE_URL reaches the DB-backed tests; in
// environments without a database the tests skip themselves.
config({ path: '../.env' });

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
