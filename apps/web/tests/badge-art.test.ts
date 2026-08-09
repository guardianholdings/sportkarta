import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LAUNCH_BADGE_SLUGS } from '@sportkarta/lib/badges';
import { describe, expect, it } from 'vitest';

import { badgeArt } from '@/lib/design/badge-art';

/**
 * Asset gate for the POPS badge coins (the same idea as og-assets.test.ts for
 * the OG fonts): every badge in the catalogue must map to a coin, and both
 * variants of every coin must actually exist in public/brand/badges — a
 * mapping typo or a missing file would otherwise surface as a silently
 * art-less tile in production.
 */

const BADGES_DIR = join(process.cwd(), 'public', 'brand', 'badges');

describe('badge coin art', () => {
  it('covers every catalogue badge', () => {
    for (const slug of LAUNCH_BADGE_SLUGS) {
      expect(badgeArt(slug), `catalogue badge ${slug} has no coin mapping`).not.toBeNull();
    }
  });

  it('both variants of every mapped coin exist and are SVG', () => {
    for (const slug of LAUNCH_BADGE_SLUGS) {
      for (const locked of [false, true]) {
        const path = badgeArt(slug, { locked });
        if (!path) continue;
        const file = join(BADGES_DIR, path.replace('/brand/badges/', ''));
        expect(existsSync(file), `${path} missing on disk`).toBe(true);
        expect(readFileSync(file, 'utf8').slice(0, 4), `${path} is not an SVG`).toBe('<svg');
      }
    }
  });

  it('an unknown slug degrades to no art, not a broken image', () => {
    expect(badgeArt('some_future_badge')).toBeNull();
  });
});
