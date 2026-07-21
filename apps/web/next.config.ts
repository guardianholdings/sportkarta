import { config } from 'dotenv';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Dev only: load the repo-root .env (Next reads just its own app dir).
// In production the container environment provides everything; the file is
// absent there and this is a no-op.
config({ path: '../../.env' });

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@sportkarta/lib', '@sportkarta/db'],
};

export default withNextIntl(nextConfig);
