'use client';

import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * The clubs page's one call to action, following the reader: a floating
 * button that appears once the first screen (the hero, `watchId`) has
 * scrolled away and goes again when it is back. Labels arrive as props, so
 * this client component reads no catalogue of its own
 * (i18n/client-messages.ts stays as it is).
 */
export function StickyCta({
  watchId,
  href,
  label,
}: {
  watchId: string;
  href: '/klubove/zayavka';
  label: string;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const hero = document.getElementById(watchId);
    if (!hero || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setShown(!entry.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, [watchId]);

  return (
    <div
      aria-hidden={!shown}
      className={cn(
        'sk-sticky-cta fixed bottom-24 right-4 z-30 transition-[opacity,transform] duration-200 ease-standard lg:bottom-6 lg:right-6',
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
      )}
    >
      <Link
        href={href}
        tabIndex={shown ? 0 : -1}
        className={cn(
          buttonVariants({ variant: 'accent', size: 'md' }),
          'shadow-lg lg:h-13 lg:px-6 lg:text-body',
        )}
      >
        {label}
        <ArrowRight size={20} aria-hidden="true" />
      </Link>
    </div>
  );
}
