'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-fetches the server component on an interval so a freshly sent code
 *  appears without a manual reload. Dev-only page, so polling is fine. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      router.refresh();
    }, seconds * 1000);
    return () => {
      clearInterval(timer);
    };
  }, [router, seconds]);
  return null;
}
