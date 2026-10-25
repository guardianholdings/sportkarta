import { formatEuro } from '@sportkarta/lib/clubs';
import { Link2, Search, UserPlus } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { StatusBadge, memberKind } from '@/components/clubs/club-state-badge';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { chipClass } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import {
  MEMBER_FILTERS,
  MEMBER_PAGE_SIZE,
  MEMBER_SEGMENTS,
  listMembers,
  type MemberFilter,
  type MemberSegment,
} from '@/lib/clubs/members';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ClubMembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ q?: string; f?: string; g?: string; s?: string; rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'members.view');
  const query = await searchParams;
  const filter: MemberFilter = (MEMBER_FILTERS as readonly string[]).includes(query.f ?? '')
    ? (query.f as MemberFilter)
    : 'all';
  const segment = (MEMBER_SEGMENTS as readonly string[]).includes(query.g ?? '')
    ? (query.g as MemberSegment)
    : null;
  const page = Math.max(0, Number.parseInt(query.s ?? '0', 10) || 0);
  const q = (query.q ?? '').slice(0, 80);
  const [t, tClub, result] = await Promise.all([
    getTranslations('ClubMembers'),
    getTranslations('Club'),
    listMembers(actor, { q, filter, segment, page }),
  ]);
  const base = `/klub/${slug}/chlenove`;
  const keep = (over: Record<string, string | undefined>) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      q: q || undefined,
      f: filter === 'all' ? undefined : filter,
      g: segment ?? undefined,
      ...over,
    })) {
      if (value) next[key] = value;
    }
    return { pathname: base, query: next };
  };
  const pages = Math.ceil(result.total / MEMBER_PAGE_SIZE);

  return (
    <main className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">
          {t('title')}{' '}
          <span className="text-body font-medium text-text-muted">
            {t('count', { count: result.total })}
          </span>
        </h1>
        {actorCan(actor, 'members.manage') && (
          <div className="flex flex-wrap gap-2">
            <Link href={`${base}/nov`} className={buttonVariants({ variant: 'primary' })}>
              <UserPlus aria-hidden="true" />
              {t('newMember')}
            </Link>
          </div>
        )}
      </div>

      {query.rezultat === 'erased' && (
        <p role="status" className="rounded-card border border-line bg-surface p-3 text-body-sm">
          {t('card.erased')}
        </p>
      )}

      <form action={base} method="get" role="search" className="flex gap-2">
        {filter !== 'all' && <input type="hidden" name="f" value={filter} />}
        {segment && <input type="hidden" name="g" value={segment} />}
        <Input
          name="q"
          type="search"
          defaultValue={q}
          aria-label={t('search')}
          placeholder={t('search')}
          iconLeft={<Search size={16} aria-hidden="true" />}
          className="flex-1"
        />
        <Button type="submit" variant="secondary">
          {t('searchSubmit')}
        </Button>
      </form>

      <nav aria-label={t('title')} className="-mx-4 overflow-x-auto px-4">
        <ul className="flex gap-2 pb-1">
          {MEMBER_FILTERS.map((value) => (
            <li key={value}>
              <Link
                href={keep({ f: value === 'all' ? undefined : value, s: undefined })}
                aria-current={value === filter ? 'page' : undefined}
                className={chipClass({ selected: value === filter, className: 'min-h-11' })}
              >
                {t(`filter.${value}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="-mx-4 overflow-x-auto px-4">
        <ul className="flex gap-2 pb-1" aria-label={t('segmentsLabel')}>
          {MEMBER_SEGMENTS.map((value) => (
            <li key={value}>
              <Link
                href={keep({ g: value === segment ? undefined : value, s: undefined })}
                aria-pressed={value === segment}
                className={chipClass({ selected: value === segment, className: 'min-h-11' })}
              >
                {tClub(`segment.${value}`)}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {result.rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface shadow-sm">
          {result.rows.map((member) => (
            <li key={member.id}>
              <Link
                href={`${base}/${member.id}`}
                className="grid gap-1 px-4 py-3 hover:bg-surface-2 focus-visible:shadow-[var(--ring)] sm:grid-cols-[1.4fr_1fr_0.8fr_0.6fr] sm:items-center sm:gap-3"
              >
                <span className="min-w-0">
                  <span className="font-semibold text-ink">{member.displayName}</span>{' '}
                  {member.isMinor && <Badge tone="info">{tClub('minor')}</Badge>}{' '}
                  {member.linkStatus === 'active' && (
                    <Link2 size={14} className="inline text-brand" aria-label={t('linked')} />
                  )}
                  {member.guardianName && (
                    <span className="block text-caption text-text-muted">
                      {t('guardianOf', { name: member.guardianName })}
                    </span>
                  )}
                  {member.tags.length > 0 && (
                    <span className="block text-caption text-text-muted">
                      {member.tags.join(' · ')}
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge
                    kind={memberKind(member.status)}
                    label={tClub(`memberStatus.${member.status}`)}
                  />
                  {member.validUntil && member.status !== 'archived' && (
                    <span className="text-caption text-text-muted">
                      {tClub('validUntil', { date: formatDate(member.validUntil, locale) })}
                    </span>
                  )}
                  {member.visitsRemaining !== null && (
                    <span className="text-caption text-text-muted">
                      {tClub('visitsLeft', { count: member.visitsRemaining })}
                    </span>
                  )}
                </span>
                <span className="text-caption text-text-muted">
                  {t('col.lastVisit')}:{' '}
                  {member.lastVisit ? formatDate(member.lastVisit, locale) : t('never')}
                </span>
                <span className="text-body-sm">
                  {member.owedCents > 0 ? (
                    <StatusBadge
                      kind={member.overdue ? 'bad' : 'warning'}
                      label={`${t('col.owed')} ${formatEuro(member.owedCents, locale)}`}
                    />
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav className="flex justify-between" aria-label={t('title')}>
          {page > 0 ? (
            <Link
              href={keep({ s: String(page - 1) })}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              {t('pagePrev')}
            </Link>
          ) : (
            <span />
          )}
          {page + 1 < pages && (
            <Link
              href={keep({ s: String(page + 1) })}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              {t('pageNext')}
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
