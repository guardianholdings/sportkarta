import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * «Предстоящи | Моят дневник» at the top of /sesii and /trenirovki (operator,
 * 2026-10-31; UX audit N2). «Тренировки» meant two pages that did not know
 * about each other: a member who came to log a run tapped the Тренировки tab
 * and found the public list, while the private log hid behind a profile pill.
 * Now both live under the one tab, a segment apart.
 *
 * Links, not a SegmentedControl: each segment is its own page with its own
 * gate (/trenirovki needs an account), so it is navigation — `aria-current`,
 * no tab roles. Drawn like the control, at the touch floor. Placed first on
 * both pages so it does not move when the heading below it changes.
 */
export async function SessionsSegments({ current }: { current: 'upcoming' | 'log' }) {
  const t = await getTranslations('Session.segments');
  const items = [
    { key: 'upcoming', href: '/sesii' },
    { key: 'log', href: '/trenirovki' },
  ] as const;
  return (
    <nav aria-label={t('label')} className="mb-5 flex w-full gap-1 rounded-pill bg-paper-sunk p-1">
      {items.map((item) => {
        const active = item.key === current;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 flex-1 items-center justify-center rounded-pill px-4 text-body-sm font-semibold transition-[background-color,color,box-shadow] duration-150 ease-standard focus-visible:shadow-[var(--ring)]',
              active ? 'bg-surface text-brand shadow-sm' : 'text-ink-soft hover:text-ink',
            )}
          >
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}
