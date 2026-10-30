import { formatEuro } from '@sportkarta/lib/clubs';
import { CreditCard, QrCode, Search, UserPlus } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { StatusBadge, memberKind } from '@/components/clubs/club-state-badge';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { todaysCheckins } from '@/lib/clubs/checkin';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { missingFor } from '@/lib/clubs/documents';
import { isUuid } from '@/lib/clubs/input';
import { searchMembers } from '@/lib/clubs/members';
import { clubLocations } from '@/lib/clubs/settings';
import { formatDate, intlLocale } from '@/lib/format';
import { cn } from '@/lib/utils';

import { deskCheckinAction } from './actions';

export const dynamic = 'force-dynamic';

/** Every `?rezultat=` the desk actions send back, with its tone. */
const OUTCOME_TONE: Readonly<Record<string, BadgeTone>> = {
  recorded: 'success',
  recorded_uncovered: 'warning',
  already: 'info',
  not_found: 'danger',
  not_allowed: 'danger',
  not_linked: 'danger',
  club_closed: 'danger',
  too_early: 'danger',
  card_invalid: 'danger',
  qr_disabled: 'danger',
  qr_expired: 'warning',
  qr_invalid: 'danger',
};

const FLASH: Readonly<Record<string, string>> = {
  success: 'border-success-border bg-success-bg',
  warning: 'border-warning-border bg-warning-bg',
  danger: 'border-danger-border bg-danger-bg',
  info: 'border-line bg-surface-2',
};

/**
 * The front desk: find a person and tick them in, take a card from the
 * barcode reader, or scan a phone's QR with the device camera — and see who
 * has come in today. Works without JavaScript (plain GET search and POST
 * forms), so a cheap tablet on bad wifi still runs the desk.
 */
export default async function ClubDeskPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ q?: string; rezultat?: string; chlen?: string; lokatsiya?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'attendance.record');
  const query = await searchParams;
  const q = (query.q ?? '').slice(0, 80);
  const [t, tClub, results, today, locations] = await Promise.all([
    getTranslations('ClubCheckin'),
    getTranslations('Club'),
    searchMembers(actor, q),
    todaysCheckins(actor),
    clubLocations(actor),
  ]);
  // A missing declaration warns at the desk and never refuses the visit (0055).
  const [tDocs, unsigned] = await Promise.all([
    getTranslations('ClubDocuments'),
    missingFor(
      actor,
      results.map((row) => row.id),
    ),
  ]);
  const active = locations.filter((location) => location.active);
  const locationId =
    isUuid(query.lokatsiya) && active.some((location) => location.id === query.lokatsiya)
      ? query.lokatsiya
      : null;
  const markedToday = new Set(today.map((row) => row.memberId));
  const canAddMember = actorCan(actor, 'members.manage');
  const tone = query.rezultat ? OUTCOME_TONE[query.rezultat] : undefined;
  const subject = isUuid(query.chlen)
    ? (today.find((row) => row.memberId === query.chlen)?.displayName ??
      results.find((row) => row.id === query.chlen)?.displayName ??
      null)
    : null;
  const timeOf = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Sofia',
  });
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const where = locationId ? <input type="hidden" name="locationId" value={locationId} /> : null;

  return (
    <main className="space-y-5">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      <div role="status" aria-live="polite">
        {query.rezultat && tone && (
          <p
            className={cn('rounded-card border p-3 text-body font-semibold text-ink', FLASH[tone])}
          >
            {t(`outcome.${query.rezultat}`, { name: subject ?? t('someone') })}
          </p>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-5">
          <section className={section} aria-labelledby="desk-search-h">
            <h2 id="desk-search-h" className="text-h4 font-bold text-ink">
              {t('searchTitle')}
            </h2>
            <form method="get" className="flex flex-wrap items-end gap-2">
              {locationId && <input type="hidden" name="lokatsiya" value={locationId} />}
              <label className="min-w-0 flex-1 text-caption text-ink-soft">
                {t('searchLabel')}
                <Input
                  type="search"
                  name="q"
                  defaultValue={q}
                  minLength={2}
                  autoComplete="off"
                  // The desk's one job is this field.
                  autoFocus={!query.rezultat}
                />
              </label>
              <Button type="submit" variant="secondary">
                <Search aria-hidden="true" />
                {t('search')}
              </Button>
            </form>
            {q.length > 0 && q.trim().length < 2 && (
              <p className="text-caption text-text-muted">{t('searchHint')}</p>
            )}
            {q.trim().length >= 2 && results.length === 0 && (
              <p className="text-body-sm text-text-muted">
                {t('noResults')}{' '}
                {canAddMember && (
                  <Link href={`/klub/${slug}/chlenove/nov`} className="font-semibold text-link">
                    <UserPlus aria-hidden="true" className="mr-1 inline size-4" />
                    {t('newMember')}
                  </Link>
                )}
              </p>
            )}
            {results.length > 0 && (
              <ul className="divide-y divide-line">
                {results.map((member) => (
                  <li key={member.id} className="flex flex-wrap items-center gap-3 py-2">
                    <span className="min-w-0 flex-1">
                      <Link
                        href={`/klub/${slug}/chlenove/${member.id}`}
                        className="font-medium text-link hover:text-link-hover"
                      >
                        {member.displayName}
                      </Link>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        {member.isMinor && <Badge tone="neutral">{tClub('minor')}</Badge>}
                        {unsigned.has(member.id) && (
                          <Link
                            href={`/klub/${slug}/chlenove/${member.id}#documents-h`}
                            className="inline-flex min-h-11 items-center rounded-pill focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                          >
                            <Badge tone="warning">{tDocs('missingBadge')}</Badge>
                          </Link>
                        )}
                        <StatusBadge
                          kind={memberKind(member.status)}
                          label={tClub(`memberStatus.${member.status}`)}
                        />
                        {member.validUntil && (
                          <span className="text-caption text-text-muted">
                            {tClub('validUntil', { date: formatDate(member.validUntil, locale) })}
                          </span>
                        )}
                        {member.visitsRemaining !== null && (
                          <span className="text-caption text-text-muted">
                            {tClub('visitsLeft', { count: member.visitsRemaining })}
                          </span>
                        )}
                        {member.owedCents > 0 && (
                          <StatusBadge
                            kind={member.overdue ? 'bad' : 'warning'}
                            label={formatEuro(member.owedCents, locale)}
                          />
                        )}
                      </span>
                    </span>
                    {markedToday.has(member.id) ? (
                      <Badge tone="success">{t('markedToday')}</Badge>
                    ) : (
                      <form action={deskCheckinAction}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="memberId" value={member.id} />
                        {where}
                        <Button type="submit" className="min-h-11">
                          {t('mark')}
                        </Button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-5 sm:grid-cols-2">
            <section className={section} aria-labelledby="desk-card-h">
              <h2 id="desk-card-h" className="flex items-center gap-2 text-h4 font-bold text-ink">
                <CreditCard aria-hidden="true" className="size-5" />
                {t('cardTitle')}
              </h2>
              <form action={deskCheckinAction} className="space-y-2">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="op" value="card" />
                {where}
                <label className="block text-caption text-ink-soft">
                  {t('cardLabel')}
                  <Input
                    name="cardKey"
                    required
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="desk-card-hint"
                    className="font-mono"
                  />
                </label>
                <p id="desk-card-hint" className="text-caption text-text-muted">
                  {t('cardHint')}
                </p>
                <Button type="submit" variant="secondary">
                  {t('cardSubmit')}
                </Button>
              </form>
            </section>
            <section className={section} aria-labelledby="desk-qr-h">
              <h2 id="desk-qr-h" className="flex items-center gap-2 text-h4 font-bold text-ink">
                <QrCode aria-hidden="true" className="size-5" />
                {t('qrTitle')}
              </h2>
              <p className="text-body-sm text-ink-soft">{t('qrHint')}</p>
            </section>
          </div>

          {active.length > 1 && (
            <form method="get" className="flex flex-wrap items-end gap-2">
              <label className="text-caption text-ink-soft">
                {t('location')}
                <Select name="lokatsiya" defaultValue={locationId ?? ''} size="sm">
                  <option value="">—</option>
                  {active.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </Select>
              </label>
              <Button type="submit" variant="secondary" size="sm">
                {t('search')}
              </Button>
            </form>
          )}
        </div>

        <section className={section} aria-labelledby="desk-today-h">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="desk-today-h" className="text-h4 font-bold text-ink">
              {t('todayTitle')}
            </h2>
            <span className="text-body-sm tabular-nums text-ink-soft">
              {t('todayCount', { count: today.length })}
            </span>
          </div>
          {today.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('todayEmpty')}</p>
          ) : (
            <ol className="divide-y divide-line">
              {today.map((row) => (
                <li
                  key={row.id}
                  className={cn(
                    'flex gap-3 py-2 text-body-sm',
                    row.memberId === query.chlen && 'rounded-xs bg-brand-subtle px-2',
                  )}
                >
                  <span className="w-12 shrink-0 font-mono tabular-nums text-ink-soft">
                    {timeOf.format(new Date(row.at))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <Link
                      href={`/klub/${slug}/chlenove/${row.memberId}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {row.displayName}
                    </Link>
                    {row.isMinor && (
                      <span className="ml-1 text-caption text-text-muted">({tClub('minor')})</span>
                    )}
                    <span className="block text-caption text-text-muted">
                      {row.classTitle ?? t('openGym')}
                      {active.length > 1 ? ` · ${row.locationName}` : ''} ·{' '}
                      {tClub(`checkinMethod.${row.method}`)}
                    </span>
                    <span className="block text-caption">
                      {row.covered ? (
                        <span className="text-ink-soft">
                          {row.planName}
                          {row.visitsRemaining !== null
                            ? ` · ${tClub('visitsLeft', { count: row.visitsRemaining })}`
                            : row.endsOn
                              ? ` · ${tClub('validUntil', { date: formatDate(row.endsOn, locale) })}`
                              : ''}
                        </span>
                      ) : (
                        <StatusBadge kind="warning" label={t('noPlan')} />
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
