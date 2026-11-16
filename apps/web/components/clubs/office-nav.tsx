'use client';

import { ScrollStrip } from '@/components/ui/scroll-strip';
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
 * Абонаменти and its hub. Both rows are ScrollStrips: on a phone they scroll
 * sideways with the current hub and page brought into view, the hub row stays
 * stuck to the top, and every target is 44px.
 */
export function OfficeNav({
  hubs,
  labels,
}: {
  hubs: OfficeNavHub[];
  labels: { hubs: string; sections: string };
}) {
  const pathname = usePathname();
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

  const pill = (active: boolean) =>
    cn(
      'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-pill px-3.5 text-body-sm font-semibold',
      active
        ? 'bg-brand-subtle text-brand'
        : 'text-ink-soft hover:bg-brand-subtle hover:text-brand',
    );

  return (
    <div className="mt-3">
      <ScrollStrip
        as="nav"
        aria-label={labels.hubs}
        activeKey={pathname}
        className="bg-paper py-1 max-sm:sticky max-sm:top-0 max-sm:z-30"
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
      </ScrollStrip>
      {activeHub && activeHub.items.length > 1 && (
        <ScrollStrip
          as="nav"
          aria-label={labels.sections}
          activeKey={pathname}
          className="mt-1 border-t border-line pt-2"
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
        </ScrollStrip>
      )}
    </div>
  );
}
