import { formatEuro, sofiaToday } from '@sportkarta/lib/clubs';
import { CircleCheck, Circle, ScanLine } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button, buttonVariants } from '@/components/ui/button';
import { Stat } from '@/components/ui/stat';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { dashboardData } from '@/lib/clubs/dashboard';
import { inboxUnreadCount } from '@/lib/clubs/inbox';
import { leadsSummary } from '@/lib/clubs/leads';
import { pendingClaims } from '@/lib/clubs/links';
import { openCharges } from '@/lib/clubs/sales';
import { weekOccurrences } from '@/lib/clubs/schedule';
import { formatDate } from '@/lib/format';

import { decideClaimAction } from './actions';

export const dynamic = 'force-dynamic';

const CHECKLIST = [
  ['location', 'nastroyki'],
  ['logo', 'nastroyki'],
  ['plan', 'abonamenti/nov'],
  ['class', 'grafik/nova'],
  ['staff', 'ekip'],
  ['members', 'chlenove/nov'],
  ['kiosk', 'nastroyki#kiosk'],
  ['publish', 'nastroyki'],
] as const;

export default async function ClubDashboardPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'office.view');
  const today = sofiaToday();
  const canPay = actorCan(actor, 'payments.view');
  const canMembers = actorCan(actor, 'members.manage');
  const canInbox = actorCan(actor, 'inbox.reply');
  const [t, data, classes, owing, claims, unread, leads] = await Promise.all([
    getTranslations('ClubOffice.dashboard'),
    dashboardData(actor),
    weekOccurrences(actor, today, null, 1),
    canPay ? openCharges(actor, { limit: 8 }) : Promise.resolve([]),
    canMembers ? pendingClaims(actor) : Promise.resolve([]),
    canInbox ? inboxUnreadCount(actor) : Promise.resolve(0),
    canMembers ? leadsSummary(actor, today) : Promise.resolve(null),
  ]);
  const leadsDue = leads?.due ?? 0;
  const base = `/klub/${slug}`;
  const doneCount = Object.values(data.checklist).filter(Boolean).length;
  const showChecklist = doneCount < CHECKLIST.length && actorCan(actor, 'settings.manage');

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        {actorCan(actor, 'attendance.record') && (
          <Link
            href={`${base}/prisastviya`}
            className={buttonVariants({ variant: 'accent', size: 'lg' })}
          >
            <ScanLine aria-hidden="true" />
            {t('deskCta')}
          </Link>
        )}
      </div>

      <section className="grid grid-cols-2 gap-4 rounded-card border border-line bg-surface p-4 shadow-sm sm:grid-cols-5">
        <Stat value={data.checkinsToday} label={t('checkinsToday')} />
        <Stat
          value={classes.filter((c) => c.status === 'scheduled').length}
          label={t('classesToday')}
        />
        <Stat
          value={club.memberCap ? `${data.activeMembers}/${club.memberCap}` : data.activeMembers}
          label={t('activeMembers')}
        />
        <Stat
          value={data.expiringCount}
          label={t('expiring')}
          tone={data.expiringCount > 0 ? 'accent' : 'default'}
        />
        {canPay && <Stat value={data.unpaidCount} label={t('unpaid')} />}
      </section>

      {(unread > 0 || leadsDue > 0) && (
        <section className="flex flex-wrap gap-2 rounded-card border border-line bg-surface p-4 shadow-sm">
          {unread > 0 && (
            <Link
              href={`${base}/vhodyashti?f=unread`}
              className={buttonVariants({ variant: 'secondary' })}
            >
              {t('inboxUnread', { count: unread })}
            </Link>
          )}
          {leadsDue > 0 && (
            <Link
              href={`${base}/chlenove/potentsialni`}
              className={buttonVariants({ variant: 'secondary' })}
            >
              {t('leadsDue', { count: leadsDue })}
            </Link>
          )}
        </section>
      )}

      {showChecklist && (
        <section className="space-y-3 rounded-card border border-brand-border bg-brand-subtle p-4">
          <div>
            <h2 className="text-h4 font-bold text-ink">{t('checklist.title')}</h2>
            <p className="text-body-sm text-ink-soft">{t('checklist.intro')}</p>
          </div>
          <ul className="grid gap-1 sm:grid-cols-2">
            {CHECKLIST.map(([key, href]) => {
              const done = data.checklist[key];
              return (
                <li key={key}>
                  <Link
                    href={`${base}/${href}`}
                    className="flex min-h-11 items-center gap-2 rounded-sm px-2 text-body-sm text-ink hover:bg-surface"
                  >
                    {done ? (
                      <CircleCheck size={18} className="text-success" aria-hidden="true" />
                    ) : (
                      <Circle size={18} className="text-text-muted" aria-hidden="true" />
                    )}
                    <span className={done ? 'text-text-muted line-through' : ''}>
                      {t(`checklist.${key}`)}
                    </span>
                    {done && <span className="sr-only">({t('checklist.done')})</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(claims.length > 0 || data.erasureRequests.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {claims.length > 0 && (
            <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
              <h2 className="text-h4 font-bold text-ink">{t('claimsTitle')}</h2>
              <p className="text-caption text-text-muted">{t('claimsHint')}</p>
              <ul className="divide-y divide-line">
                {claims.map((claim) => (
                  <li
                    key={claim.memberId}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <Link
                      href={`${base}/chlenove/${claim.memberId}`}
                      className="font-medium text-link"
                    >
                      {claim.memberName}
                    </Link>
                    <div className="flex gap-2">
                      {(['approve', 'reject'] as const).map((decision) => (
                        <form key={decision} action={decideClaimAction}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="memberId" value={claim.memberId} />
                          <input type="hidden" name="decision" value={decision} />
                          <Button
                            type="submit"
                            size="sm"
                            variant={decision === 'approve' ? 'primary' : 'secondary'}
                          >
                            {t(decision)}
                          </Button>
                        </form>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.erasureRequests.length > 0 && (
            <section className="space-y-2 rounded-card border border-danger-border bg-danger-bg p-4">
              <h2 className="text-h4 font-bold text-ink">{t('erasureTitle')}</h2>
              <p className="text-caption text-ink-soft">{t('erasureHint')}</p>
              <ul className="divide-y divide-line">
                {data.erasureRequests.map((request) => (
                  <li
                    key={request.memberId}
                    className="flex items-center justify-between gap-2 py-2"
                  >
                    <span className="font-medium text-ink">{request.memberName}</span>
                    <Link
                      href={`${base}/chlenove/${request.memberId}`}
                      className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                    >
                      {t('open')}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
        <h2 className="text-h4 font-bold text-ink">{t('todayClasses')}</h2>
        {classes.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('noClassesToday')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {classes.map((occ) => (
              <li key={occ.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <span className="font-mono text-body-sm tabular-nums text-ink">
                    {occ.localStart.slice(11)}
                  </span>{' '}
                  <span
                    className={`font-semibold ${occ.status === 'cancelled' ? 'text-text-muted line-through' : 'text-ink'}`}
                  >
                    {occ.title}
                  </span>
                  <span className="block text-caption text-text-muted">
                    {occ.locationName}
                    {occ.instructorName ? ` · ${occ.instructorName}` : ''} · {occ.going}
                    {occ.capacity ? `/${occ.capacity}` : ''}
                  </span>
                </div>
                {(actorCan(actor, 'roster.view') || occ.mine) && (
                  <Link
                    href={`${base}/grafik/t/${occ.id}`}
                    className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                  >
                    {t('roster')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {actorCan(actor, 'members.view') && (
          <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
            <h2 className="text-h4 font-bold text-ink">{t('expiringTitle')}</h2>
            {data.expiring.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('noneExpiring')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.expiring.map((row) => (
                  <li
                    key={`${row.memberId}-${row.planId}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <div>
                      <Link
                        href={`${base}/chlenove/${row.memberId}`}
                        className="font-medium text-link"
                      >
                        {row.memberName}
                      </Link>
                      <span className="block text-caption text-text-muted">
                        {row.planName} · {formatDate(row.endsOn, locale)}
                      </span>
                    </div>
                    {actorCan(actor, 'sales.manage') && (
                      <Link
                        href={{
                          pathname: `${base}/abonamenti/prodazhba`,
                          query: { chlen: row.memberId, plan: row.planId },
                        }}
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                      >
                        {t('renew')}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {canPay && (
          <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
            <h2 className="text-h4 font-bold text-ink">{t('owingTitle')}</h2>
            {owing.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('noneOwing')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {owing.map((charge) => (
                  <li
                    key={charge.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <div>
                      {charge.memberId ? (
                        <Link
                          href={`${base}/chlenove/${charge.memberId}`}
                          className="font-medium text-link"
                        >
                          {charge.memberName}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink">—</span>
                      )}
                      <span className="block text-caption text-text-muted">
                        {charge.label} · {formatEuro(charge.dueCents, locale)} ·{' '}
                        {formatDate(charge.dueOn, locale)}
                      </span>
                    </div>
                    {actorCan(actor, 'payments.record') && (
                      <Link
                        href={{
                          pathname: `${base}/plashtaniya`,
                          query: { zadalzhenie: charge.id },
                        }}
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                      >
                        {t('recordPayment')}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
