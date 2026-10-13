import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../fonts.css';
import '../globals.css';

/**
 * The /tiktok demo's own document. It sits outside [locale] —
 * the middleware matcher skips /tiktok and /auth/tiktok — so, like the root
 * not-found, it renders its own <html> above the pass-through root layout.
 * English: the audience is TikTok's app reviewers.
 *
 * Unlisted on purpose: no link from the site, not in the sitemap, noindex
 * here and in the X-Robots-Tag header (next.config.ts). No analytics script.
 */

export const metadata: Metadata = {
  title: 'POPS — post a video to TikTok',
  robots: { index: false, follow: false },
};

export default function TikTokLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
