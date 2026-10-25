import { getTranslations, setRequestLocale } from 'next-intl/server';

import { ClubStateBadge } from '@/components/clubs/club-state-badge';
import { Link } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';
import { cityDisplayName } from '@/lib/city-names';
import {
  ADMIN_CLUB_FILTERS,
  adminClubCounts,
  adminClubList,
  type AdminClubFilter,
} from '@/lib/clubs/admin';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * /admin/klubove — the operator's list of «Клубове» tenants, by state.
 * Applications first: approving one starts the trial (lib/clubs/admin.ts).
 * Admin-only (requireRole('admin')); the owner's address is shown because the
 * operator invoices the club and has to be able to write to it.
 */
export default async function AdminClubsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string; rezultat?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  await requireRole('admin');
  const { tab: tabParam, rezultat } = await searchParams;
  const tab: AdminClubFilter = (ADMIN_CLUB_FILTERS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as AdminClubFilter)
    : 'pending';
  const [t, tClub, rows, counts] = await Promise.all([
    getTranslations('AdminClubs'),
    getTranslations('Club'),
    adminClubList(tab),
    adminClubCounts(),
  ]);

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
        <p className="mt-1.5 max-w-prose text-caption text-text-muted">{t('invoiceNote')}</p>
      </div>

      {rezultat === 'purged' && (
        <p role="status" className="rounded-card border border-line bg-surface p-3 text-body-sm">
          {t('purged')}
        </p>
      )}

      <nav aria-label={t('title')} className="-mx-4 overflow-x-auto px-4">
        <ul className="flex gap-1">
          {ADMIN_CLUB_FILTERS.map((filter) => {
            const active = filter === tab;
            return (
              <li key={filter}>
                <Link
                  href={{ pathname: '/admin/klubove', query: { tab: filter } }}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-pill px-3.5 text-body-sm font-medium ${
                    active
                      ? 'bg-brand-subtle text-brand'
                      : 'text-ink-soft hover:bg-brand-subtle hover:text-brand'
                  }`}
                >
                  {t(`tab.${filter}`)}
                  <span className="font-mono text-caption tabular-nums">{counts[filter]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
          <table className="w-full min-w-[48rem] text-body-sm">
            <thead>
              <tr className="border-b border-line bg-paper-sunk text-left">
                {(
                  [
                    'club',
                    'city',
                    'tier',
                    'state',
                    'owner',
                    'members',
                    'active',
                    'applied',
                  ] as const
                ).map((col) => (
                  <th key={col} scope="col" className="t-overline px-3 py-2.5 font-semibold">
                    {t(`col.${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((club) => (
                <tr key={club.id}>
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/admin/klubove/${club.slug}`}
                      className="font-semibold text-link hover:text-link-hover"
                    >
                      {club.nameBg}
                    </Link>
                    <span className="block text-caption text-text-muted">
                      {tClub(`kind.${club.kind}`)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-ink-soft">
                    {club.cityBg ? cityDisplayName(club.cityBg, club.cityEn ?? '', locale) : '—'}
                  </td>
                  <td className="px-3 py-2.5">{tClub(`tier.${club.tier}`)}</td>
                  <td className="px-3 py-2.5">
                    <ClubStateBadge
                      state={club.accessState}
                      label={tClub(`state.${club.accessState}`)}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    {club.owners === 0 ? (
                      <span className="font-semibold text-danger">{t('ownerless')}</span>
                    ) : (
                      <>
                        <span className="block text-ink">{club.ownerName || '—'}</span>
                        <span className="block text-caption text-text-muted">
                          {club.ownerEmail}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">{club.members}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    {club.lastMonthActive ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-caption text-text-muted">
                    {formatDate(club.appliedAt, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
