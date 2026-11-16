'use client';

import { useEffect } from 'react';

import { forgetCard } from '@/lib/map/card';

/**
 * Rendered by the facility page, for the map the member goes back to.
 *
 * The map remembers the cards it has opened for a minute (lib/map/card.ts), and
 * the card of an unchecked place sends the member here to confirm it. Without
 * this, they would confirm it, go back, and be asked again by a card still
 * saying «Очаква проверка». Being on this page is what makes the remembered
 * copy doubtful, whatever they then do here, so it is dropped on arrival.
 * Renders nothing, stores nothing on the device.
 */
export function FreshFacilityCard({ slug }: { slug: string }) {
  useEffect(() => {
    forgetCard(slug);
  }, [slug]);
  return null;
}
