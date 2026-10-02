import { getTranslations } from 'next-intl/server';

import { FacilityList } from '@/components/places/facility-list';
import { AppShell } from '@/components/shell/app-shell';
import { Link } from '@/i18n/navigation';
import { listPageCount, type ScopedFacility } from '@/lib/places';

import { ListPager } from './list-pager';

/**
 * List page 2..n of a place listing (/igrishta/<city>[/<segment>]/stranitsa/<n>).
 *
 * Only the list and the pager: page 1 already carries the intro, the map (which
 * shows the WHOLE scope, so repeating it here would add payload and nothing
 * else) and the cross-links. The heading names the listing and the page, and
 * the back link returns to page 1, where the rest of the context lives.
 */
export async function PlaceListPage({
  basePath,
  heading,
  page,
  total,
  facilities,
}: {
  basePath: string;
  /** The listing's own heading, as page 1 shows it. */
  heading: string;
  page: number;
  total: number;
  facilities: ScopedFacility[];
}) {
  const t = await getTranslations('Places');
  const pages = listPageCount(total);

  return (
    <AppShell>
      <main className="mx-auto max-w-3xl space-y-6 p-4">
        <Link href={basePath} className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('backToListing', { heading })}
        </Link>

        <header>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">
            {t('pagedHeading', { heading, page, pages })}
          </h1>
        </header>

        <section aria-label={t('facilitiesHeading')}>
          <FacilityList facilities={facilities} />
          <ListPager basePath={basePath} page={page} total={total} />
        </section>
      </main>
    </AppShell>
  );
}
