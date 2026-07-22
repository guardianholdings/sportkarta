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
  experimental: {
    // Report photos are up to 8 MB (lib/image.ts MAX_PHOTO_BYTES); the default
    // server-action body limit (1 MB) would reject real phone photos before our
    // own size check runs. Headroom above 8 MB covers multipart form overhead.
    serverActions: { bodySizeLimit: '10mb' },
  },
  webpack: (config: { resolve: { extensionAlias?: Record<string, string[]> } }) => {
    // Workspace packages use ESM ".js" specifiers over TS sources (nodenext
    // compatibility for apps/worker); map them back to .ts for webpack.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default withNextIntl(nextConfig);
