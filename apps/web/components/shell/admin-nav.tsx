'use client';

import { Link, usePathname } from '@/i18n/navigation';

/**
 * The admin section nav. Client-side only for one reason: the CURRENT page
 * must be marked (aria-current + fill) and the server layout cannot know the
 * pathname. Labels arrive resolved — i18n stays in the server layout.
 *
 * Longest-prefix match, not equality: /admin/kampanii/nova belongs to the
 * "Кампании" tab, and bare /admin must not light up for every child route.
 */
export function AdminNav({ items }: { items: readonly { href: string; label: string }[] }) {
  const pathname = usePathname();
  const current = items.reduce<string | null>((best, item) => {
    const hit = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (!hit) return best;
    return best === null || item.href.length > best.length ? item.href : best;
  }, null);

  return (
    <nav className="mt-3 flex flex-wrap gap-1">
      {items.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-pill px-3 py-1.5 text-body-sm font-medium ${
              active
                ? 'bg-brand-subtle text-brand'
                : 'text-ink-soft hover:bg-brand-subtle hover:text-brand'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
