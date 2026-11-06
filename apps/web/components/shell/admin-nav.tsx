'use client';

import { ScrollStrip } from '@/components/ui/scroll-strip';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * The admin section nav. Client-side only for one reason: the CURRENT page
 * must be marked (aria-current + fill) and the server layout cannot know the
 * pathname. Labels arrive resolved — i18n stays in the server layout.
 *
 * Longest-prefix match, not equality: /admin/kampanii/nova belongs to the
 * "Кампании" tab, and bare /admin must not light up for every child route.
 *
 * One ScrollStrip: on a phone the sixteen links are a single row that scrolls
 * sideways and brings the current one into view (UX audit 2026-10-31, V-27 —
 * until now it never did), each a 44px target; from `sm` they wrap as before.
 */
export function AdminNav({
  items,
  label,
}: {
  items: readonly { href: string; label: string }[];
  label: string;
}) {
  const pathname = usePathname();
  const current = items.reduce<string | null>((best, item) => {
    const hit = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (!hit) return best;
    return best === null || item.href.length > best.length ? item.href : best;
  }, null);

  return (
    <ScrollStrip as="nav" aria-label={label} activeKey={pathname} wrapFrom="sm" className="mt-3">
      {items.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-pill px-3 text-body-sm font-medium sm:min-h-9',
              active
                ? 'bg-brand-subtle text-brand'
                : 'text-ink-soft hover:bg-brand-subtle hover:text-brand',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </ScrollStrip>
  );
}
