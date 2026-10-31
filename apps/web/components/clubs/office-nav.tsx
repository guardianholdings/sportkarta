'use client';

import { useEffect, useRef } from 'react';

import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export interface OfficeNavHub {
  key: string;
  label: string;
  items: { href: string; label: string }[];
  /** Pages of this hub that are not in its row (the desk scanner). */
  also: string[];
}

/**
 * The office nav (lib/clubs/office-nav.ts): a row of hubs and, under it, the
 * sections of the hub you are in. Client-side for one reason, as AdminNav: the
 * current page must be marked and the server layout cannot know the pathname.
 * Labels arrive resolved.
 *
 * Longest-prefix match across every section, so /abonamenti/prodazhba lights
 * Абонаменти and its hub. On a phone the hub row is sticky and scrolls
 * sideways if it must; every target is 44px.
 */
export function OfficeNav({
  hubs,
  labels,
}: {
  hubs: OfficeNavHub[];
  labels: { hubs: string; sections: string };
}) {
  const pathname = usePathname();
  const rowsRef = useRef<HTMLDivElement>(null);
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  let current: string | null = null;
  for (const hub of hubs) {
    for (const item of hub.items) {
      if (under(item.href) && (current === null || item.href.length > current.length)) {
        current = item.href;
      }
    }
  }
  const activeHub =
    hubs.find((hub) => hub.items.some((item) => item.href === current)) ??
    hubs.find((hub) => hub.also.some(under)) ??
    null;

  // On a phone the rows scroll sideways, and «Пари» or «Настройки» starts out
  // of sight: bring the current hub and page into view (without moving the
  // page itself — `nearest` on the block axis).
  useEffect(() => {
    for (const el of rowsRef.current?.querySelectorAll<HTMLElement>('[aria-current]') ?? []) {
      el.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }, [pathname]);

  const pill = (active: boolean) =>
    cn(
      'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-pill px-3.5 text-body-sm font-semibold',
      active
        ? 'bg-brand-subtle text-brand'
        : 'text-ink-soft hover:bg-brand-subtle hover:text-brand',
    );

  return (
    <div ref={rowsRef} className="mt-3">
      <nav
        aria-label={labels.hubs}
        className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto bg-paper px-4 py-1 max-sm:sticky max-sm:top-0 max-sm:z-30"
      >
        {hubs.map((hub) => {
          const active = hub === activeHub;
          return (
            <Link
              key={hub.key}
              href={hub.items[0]?.href ?? '#'}
              aria-current={active ? 'true' : undefined}
              className={pill(active)}
            >
              {hub.label}
            </Link>
          );
        })}
      </nav>
      {activeHub && activeHub.items.length > 1 && (
        <nav
          aria-label={labels.sections}
          className="scrollbar-none -mx-4 mt-1 flex gap-1 overflow-x-auto border-t border-line px-4 pt-2"
        >
          {activeHub.items.map((item) => {
            const active = item.href === current;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-body-sm',
                  active
                    ? 'font-semibold text-brand underline decoration-2 underline-offset-8'
                    : 'font-medium text-ink-soft hover:text-brand',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
