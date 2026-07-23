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
  // Framing policy (Stage 3.4). The municipality widget under /api/widget is
  // the ONE surface meant to be embedded on other people's sites, and it sets
  // `frame-ancestors *` on its own response. Everything else — the admin shell,
  // the moderation queue, the profile and passport pages — is denied here, so
  // adding the widget did not quietly make the whole app frameable.
  //
  // The negative lookahead is deliberate rather than relying on rule ordering:
  // two overlapping `source` entries both match, and which Content-Security-
  // Policy survives is not something to leave to precedence rules.
  async headers() {
    return [
      {
        source: '/:path((?!api/widget).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
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
