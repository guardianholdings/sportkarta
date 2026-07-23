// @ts-check
import eslint from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      // Git worktrees created for background/spawned tasks live here; they are
      // separate checkouts with their own state and must not be linted as part
      // of this repo.
      '.claude/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/next-env.d.ts',
      'db/migrations/**',
      // Node asset-generation + service-worker scripts (own runtime, not app code).
      'apps/web/scripts/**',
      'apps/web/public/sw.js',
      // Seed design handoff — read-only reference bundle (browser-runtime .js /
      // .jsx prototype, not our source). Authority for the design system; never
      // linted, typechecked, or built. See docs/design/RECONCILIATION.md.
      'docs/design/design_handoff_sports_map_platform/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
    settings: {
      next: {
        rootDir: 'apps/web',
      },
    },
  },
  prettier,
);
