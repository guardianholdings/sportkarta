import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  // The OG cards are JSX (lib/og/card.tsx) rendered through next/og in plain
  // Node — no browser, no Next runtime. Next compiles the app with the AUTOMATIC
  // JSX runtime; esbuild here defaults to the classic one, which emits
  // `React.createElement` and fails with "React is not defined". Matching Next
  // is the fix — adding a React import to production code to satisfy a test
  // would be the tail wagging the dog.
  esbuild: { jsx: 'automatic' },
  // Mirror the app's "@/*" path alias so tested modules resolve it the same
  // way Next does.
  resolve: {
    alias: { '@': dir },
  },
});
