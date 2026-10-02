import { getTranslations } from 'next-intl/server';

import { chipClass } from '@/components/ui/chip';
import { Link } from '@/i18n/navigation';
import { LIST_PAGE_SIZE, listPageCount, listPagePath } from '@/lib/places';

/**
 * The place pages' list pager: "showing 61–120 of 1615" plus a link to every
 * page. Real links, not a "load more" button — the list is the way in for
 * keyboard, screen-reader and no-JS visitors and for crawlers, and every one of
 * them must be able to reach the last facility in Sofia without the map.
 *
 * Every page is linked (27 for Sofia, the largest), so no page is more than one
 * hop from any other. Renders nothing when the scope fits on one page.
 */
export async function ListPager({
  basePath,
  page,
  total,
}: {
  /** The listing's page-1 path, e.g. /igrishta/sofia or /igrishta/sofia/football. */
  basePath: string;
  page: number;
  total: number;
}) {
  const pages = listPageCount(total);
  if (pages <= 1) return null;
  const t = await getTranslations('Places');
  const from = (page - 1) * LIST_PAGE_SIZE + 1;
  const to = Math.min(page * LIST_PAGE_SIZE, total);
  const numbers = Array.from({ length: pages }, (_, i) => i + 1);

  return (
    <div className="mt-3 space-y-2">
      <p className="text-body-sm text-text-muted">{t('showingRange', { from, to, total })}</p>
      <nav aria-label={t('pagerLabel')}>
        <ul className="flex flex-wrap items-center gap-1.5">
          {page > 1 && (
            <li>
              <Link href={listPagePath(basePath, page - 1)} rel="prev" className={chipClass()}>
                {t('pagerPrevious')}
              </Link>
            </li>
          )}
          {numbers.map((n) => (
            <li key={n}>
              <Link
                href={listPagePath(basePath, n)}
                aria-label={t('pagerPage', { page: n })}
                aria-current={n === page ? 'page' : undefined}
                className={chipClass({ selected: n === page, className: 'tabular-nums' })}
              >
                {n}
              </Link>
            </li>
          ))}
          {page < pages && (
            <li>
              <Link href={listPagePath(basePath, page + 1)} rel="next" className={chipClass()}>
                {t('pagerNext')}
              </Link>
            </li>
          )}
        </ul>
      </nav>
    </div>
  );
}
