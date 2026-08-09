import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ACCOUNTS_PAGE_SIZE, listAccounts, type AccountFilters } from '@/lib/account-admin';
import { requireRole } from '@/lib/auth-session';
import { isRole, type Role } from '@/lib/roles';
import { Link } from '@/i18n/navigation';

export const metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * The account index (Stage 3, admin account management).
 *
 * ADMIN-ONLY, and that is not the panel-level gate. `requireAdmin()` means
 * "ambassador or admin" — an ambassador's authority is a set of municipalities
 * and has nothing to do with reading a member's whole record, so this screen and
 * its detail page both call `requireRole('admin')` explicitly. An unprivileged
 * account gets notFound(), not a forbidden page: nobody below the rank has any
 * business learning that this route exists.
 *
 * The list itself is deliberately unremarkable — it exists to FIND one person.
 * Everything sensitive lives one click away, where opening it is recorded.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(sp: Record<string, string | string[] | undefined>): AccountFilters {
  const page = Number(first(sp.p) ?? '1');
  const role = first(sp.role);
  const visibility = first(sp.vidimost);
  const consent = first(sp.saglasie);
  return {
    ...(first(sp.q) ? { q: String(first(sp.q)) } : {}),
    ...(role && isRole(role) ? { role } : {}),
    ...(visibility === 'public' || visibility === 'private' ? { visibility } : {}),
    ...(consent === 'route' || consent === 'health' ? { consent } : {}),
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

/** Rebuild the query string with one key changed — used by the filter pills. */
function href(base: AccountFilters, patch: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  if (base.q) params.set('q', base.q);
  if (base.role) params.set('role', base.role);
  if (base.visibility) params.set('vidimost', base.visibility);
  if (base.consent) params.set('saglasie', base.consent);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  params.delete('p');
  const query = params.toString();
  return query ? `/admin/akaunti?${query}` : '/admin/akaunti';
}

export default async function AdminAccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const filters = parseFilters(await searchParams);
  const [t, activeLocale, { rows, total }] = await Promise.all([
    getTranslations('AdminAccounts'),
    getLocale(),
    listAccounts(filters),
  ]);

  const dateFmt = new Intl.DateTimeFormat(activeLocale, { dateStyle: 'medium' });
  const fmt = (value: string | null): string =>
    value ? dateFmt.format(new Date(value)) : t('none');
  const pages = Math.max(1, Math.ceil(total / ACCOUNTS_PAGE_SIZE));

  const roleLabel: Record<Role, string> = {
    user: t('roleUser'),
    ambassador: t('roleAmbassador'),
    admin: t('roleAdmin'),
  };

  const pill = (active: boolean): string =>
    active
      ? 'inline-flex min-h-9 items-center rounded-pill bg-brand px-3 text-caption font-semibold text-on-brand'
      : 'inline-flex min-h-9 items-center rounded-pill border border-line-strong bg-surface px-3 text-caption font-medium text-ink-soft hover:bg-surface-2';

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1 text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      <form className="flex flex-wrap items-end gap-2" action="/admin/akaunti">
        {/* Preserve the active filters across a new search. */}
        {filters.role && <input type="hidden" name="role" value={filters.role} />}
        {filters.visibility && <input type="hidden" name="vidimost" value={filters.visibility} />}
        {filters.consent && <input type="hidden" name="saglasie" value={filters.consent} />}
        <label className="flex-1 space-y-1.5">
          <span className="text-caption font-medium text-ink-soft">{t('searchLabel')}</span>
          <Input
            type="search"
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder={t('searchPlaceholder')}
            className="max-w-md"
          />
        </label>
        <Button type="submit" variant="secondary">
          {t('search')}
        </Button>
      </form>

      <div className="space-y-2">
        <FilterRow label={t('filterRole')}>
          <Link href={href(filters, { role: undefined })} className={pill(!filters.role)}>
            {t('all')}
          </Link>
          {(['user', 'ambassador', 'admin'] as const).map((role) => (
            <Link key={role} href={href(filters, { role })} className={pill(filters.role === role)}>
              {roleLabel[role]}
            </Link>
          ))}
        </FilterRow>
        <FilterRow label={t('filterVisibility')}>
          <Link href={href(filters, { vidimost: undefined })} className={pill(!filters.visibility)}>
            {t('all')}
          </Link>
          <Link
            href={href(filters, { vidimost: 'public' })}
            className={pill(filters.visibility === 'public')}
          >
            {t('visibilityPublic')}
          </Link>
          <Link
            href={href(filters, { vidimost: 'private' })}
            className={pill(filters.visibility === 'private')}
          >
            {t('visibilityPrivate')}
          </Link>
        </FilterRow>
        <FilterRow label={t('filterConsent')}>
          <Link href={href(filters, { saglasie: undefined })} className={pill(!filters.consent)}>
            {t('all')}
          </Link>
          <Link
            href={href(filters, { saglasie: 'route' })}
            className={pill(filters.consent === 'route')}
          >
            {t('consentRoute')}
          </Link>
          <Link
            href={href(filters, { saglasie: 'health' })}
            className={pill(filters.consent === 'health')}
          >
            {t('consentHealth')}
          </Link>
        </FilterRow>
      </div>

      <p className="font-mono text-caption text-text-muted">{t('resultCount', { count: total })}</p>

      {rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-line text-left text-caption text-text-muted">
                <th scope="col" className="t-overline py-2 pr-3 font-medium">
                  {t('columnMember')}
                </th>
                <th scope="col" className="t-overline py-2 pr-3 font-medium">
                  {t('columnRole')}
                </th>
                <th scope="col" className="t-overline py-2 pr-3 font-medium">
                  {t('columnCity')}
                </th>
                <th scope="col" className="t-overline py-2 pr-3 text-right font-medium">
                  {t('columnPoints')}
                </th>
                <th scope="col" className="t-overline py-2 pr-3 text-right font-medium">
                  {t('columnEdits')}
                </th>
                <th scope="col" className="t-overline py-2 pr-3 text-right font-medium">
                  {t('columnTrainings')}
                </th>
                <th scope="col" className="t-overline py-2 pr-3 text-right font-medium">
                  {t('columnCheckins')}
                </th>
                <th scope="col" className="t-overline py-2 pr-3 font-medium">
                  {t('columnLastActive')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <th scope="row" className="t-overline py-2 pr-3 text-left font-normal">
                    <Link
                      href={`/admin/akaunti/${row.id}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {row.displayName || t('noName')}
                    </Link>
                    <span className="block break-all text-caption text-text-muted">
                      {row.email}
                    </span>
                  </th>
                  <td className="py-2 pr-3">
                    {row.role === 'user' ? (
                      <span className="text-text-muted">{roleLabel.user}</span>
                    ) : (
                      <Badge tone={row.role === 'admin' ? 'danger' : 'brand'}>
                        {roleLabel[row.role]}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-ink-soft">{row.homeCity ?? t('none')}</td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">{row.points}</td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">{row.edits}</td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">{row.trainings}</td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">{row.checkins}</td>
                  <td className="py-2 pr-3 font-mono text-caption text-text-muted">
                    {fmt(row.lastActiveAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="flex items-center gap-3">
          {filters.page > 1 && (
            <Link
              href={`${href(filters, {})}${href(filters, {}).includes('?') ? '&' : '?'}p=${String(filters.page - 1)}`}
              className="text-body-sm font-medium text-link hover:text-link-hover"
            >
              {t('previous')}
            </Link>
          )}
          <span className="font-mono text-caption text-text-muted">
            {t('page', { page: filters.page, pages })}
          </span>
          {filters.page < pages && (
            <Link
              href={`${href(filters, {})}${href(filters, {}).includes('?') ? '&' : '?'}p=${String(filters.page + 1)}`}
              className="text-body-sm font-medium text-link hover:text-link-hover"
            >
              {t('next')}
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="t-overline w-20 shrink-0 text-text-muted">{label}</span>
      {children}
    </div>
  );
}
