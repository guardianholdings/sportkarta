import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  // Mirror the app's "@/*" path alias so tested modules resolve it the same
  // way Next does.
  resolve: {
    alias: { '@': dir },
  },
});
