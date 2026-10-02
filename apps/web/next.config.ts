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
  // No component renders next/image — photos are re-encoded to WebP at upload
  // (lib/image.ts) and served as-is — yet /_next/image was live, re-running
  // sharp on every request with no cache, and it is where Next's image-
  // optimizer advisories land. Unoptimized takes the endpoint out entirely.
  images: { unoptimized: true },
  // Do not advertise the framework (and so its version family) on every response.
  poweredByHeader: false,
  experimental: {
    // Report photos are up to 8 MB (lib/image.ts MAX_PHOTO_BYTES); the default
    // server-action body limit (1 MB) would reject real phone photos before our
    // own size check runs. Headroom above 8 MB covers multipart form overhead.
    serverActions: { bodySizeLimit: '10mb' },
    // ISR entries (the /igrishta, /sedmitsata and /sitemaps pages) live in
    // Next's in-memory LRU only. On disk they would be written beside the
    // compiled app in .next/server/app, which the image keeps root-owned and
    // read-only to the runtime user on purpose (Dockerfile) — so every
    // regeneration logged an EACCES warning — and the set of cacheable URLs is
    // open-ended (any slug a crawler invents renders a cacheable 404), which an
    // LRU bounds and a directory does not. The cache does not survive a restart,
    // and a deploy is exactly when it should not.
    isrFlushToDisk: false,
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
          // A facility photo or an open-data CSV is served from our own origin;
          // without nosniff a browser may re-interpret an uploaded file as
          // something executable on the strength of its bytes alone.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Passport and session URLs carry a member's handle or a token. The
          // default policy would send the full URL to any third party the page
          // links out to — the partner links on /partnyori are exactly that.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Deliberately NOT denied here: geolocation, which the proximity
          // check and the check-in flow both need, and camera — the photo
          // inputs use `capture="environment"`, and some browsers apply this
          // policy to that attribute, which would silently break the mobile
          // contribution flow this product depends on.
          {
            key: 'Permissions-Policy',
            value: 'microphone=(), payment=(), interest-cohort=()',
          },
        ],
      },
      // Static assets from public/. Next serves every public file with
      // `max-age=0` because it cannot know which ones change, so the map
      // revalidated its glyph ranges (~400 KB on a first view) and the app
      // icons on every load. These rules say what we know about each set.
      {
        // MapLibre glyph ranges: one file per font stack and Unicode range,
        // generated once and never edited in place — a new font is a new
        // directory name. A month is safe; immutable is not claimed, because
        // the URL does not carry a content hash.
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000' }],
      },
      {
        // The glyph PBFs are protobuf but went out as application/octet-stream,
        // which Caddy's default `encode` matcher skips — 134 KB on the wire
        // where 83 KB would do. Naming the real type, which is on that default
        // list, gets them compressed with no Caddyfile change.
        source: '/fonts/:fontstack/:range(\\d+-\\d+\\.pbf)',
        headers: [{ key: 'Content-Type', value: 'application/x-protobuf' }],
      },
      {
        // App icons keep their paths when their pixels change (the POPS
        // rebrand did exactly that), so they get a day plus a background
        // refresh rather than a long lifetime that would pin a retired icon.
        source: '/icons/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
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
