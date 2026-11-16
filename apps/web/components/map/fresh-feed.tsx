'use client';

import { useEffect } from 'react';

import { requireFreshFeed } from '@/lib/map/feed';

/**
 * Rendered where a member is thanked for a place they have just added. It
 * draws nothing: it tells the map, for as long as this tab lives, to read its
 * facilities past the browser's cache — so the pin they came to see is there
 * (lib/map/feed.ts).
 */
export function FreshMapFeed() {
  useEffect(() => {
    requireFreshFeed();
  }, []);
  return null;
}
