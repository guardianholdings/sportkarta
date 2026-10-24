import { CLUB_CANCEL_REASONS, addDaysIso, formatEuro, sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ClubLog } from '@/components/clubs/club-log';
import {
  StatusBadge,
  chargeKind,
  memberKind,
  membershipKind,
} from '@/components/clubs/club-state-badge';
import { IssueCardButton } from '@/components/clubs/member-form';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { clubAuditHistory } from '@/lib/clubs/audit';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { memberCard } from '@/lib/clubs/members';
import { formatDate, formatDateTime } from '@/lib/format';

import { issueCardAction, memberOpAction, pauseAction } from '../actions';

export const dynamic = 'force-dynamic';

const OUTCOMES = new Set([
  'saved',
  'invited',
  'checked_in',
  'checked_in_uncovered',
  'already',
  'club_closed',
  'not_linked',
]);

export default async function MemberCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string; memberId: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, memberId } = await params;
  setRequestLocale(locale);
  if (!isUuid(memberId)) notFound();
  const { actor } = await requireClubStaff(slug, 'members.view');
  const member = await memberCard(actor, memberId);
  if (!member) notFound();
  const [t, tClub, messages, history] = await Promise.all([
    getTranslations('ClubMembers'),
    getTranslations('Club'),
    clubFormMessages(),
    actorCan(actor, 'audit.view')
      ? clubAuditHistory(actor.clubId, { subjectMemberId: memberId }, 30)
      : Promise.resolve([]),
  ]);
  const { rezultat } = await searchParams;
  const base = `/klub/${slug}`;
  const today = sofiaToday();
  const op = (name: string, extra?: Record<string, string>) => (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="op" value={name} />
      {extra &&
        Object.entries(extra).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
    </>
  );
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const outcome = rezultat
    ? OUTCOMES.has(rezultat)
      ? t(`card.outcome.${rezultat}`)
      : rezultat === 'readOnly'
        ? messages.readOnly
        : (messages.errors[rezultat] ?? null)
    : null;
  const outcomeIsGood = rezultat === 'saved' || rezultat === 'invited' || rezultat === 'checked_in';
  const linkState = member.link ? member.link.status : member.pendingInvite ? 'invited' : 'none';

  return (
    <main className="space-y-5">
      <Link
        href={`${base}/chlenove`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('card.back')}
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{member.displayName}</h1>
          {member.isMinor && <Badge tone="info">{tClub('minor')}</Badge>}
          <StatusBadge
            kind={memberKind(member.status)}
            label={tClub(`memberStatus.${member.status}`)}
          />
        </div>
        <p className="text-body-sm text-ink-soft">
          {member.validUntil &&
            tClub('validUntil', { date: formatDate(member.validUntil, locale) })}
          {member.visitsRemaining !== null &&
            ` · ${tClub('visitsLeft', { count: member.visitsRemaining })}`}
          {member.owedCents > 0 && ` · ${t('col.owed')} ${formatEuro(member.owedCents, locale)}`}
        </p>
        <p className="text-caption text-text-muted">
          {t(`card.link.${linkState}`)}
          {member.link?.passportConsent ? ` · ${t('card.link.passportOn')}` : ''}
        </p>
      </header>

      {outcome && (
        <p
          role="status"
          className={`rounded-card border p-3 text-body-sm text-ink ${
            outcomeIsGood
              ? 'border-success-border bg-success-bg'
              : 'border-warning-border bg-warning-bg'
          }`}
        >
          {outcome}
        </p>
      )}
      {member.erasureRequested && (
        <p
          role="alert"
          className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm font-semibold text-ink"
        >
          {t('card.erasureRequested')}
        </p>
      )}

      <section className={section}>
        <h2 className="sr-only">{t('card.actions')}</h2>
        <div className="flex flex-wrap gap-2">
          {actorCan(actor, 'attendance.record') && !member.archivedAt && (
            <form action={memberOpAction}>
              {op('checkin')}
              <Button type="submit" variant="accent">
                {t('card.checkInNow')}
              </Button>
            </form>
          )}
          {actorCan(actor, 'sales.manage') && !member.archivedAt && (
            <Link
              href={{ pathname: `${base}/abonamenti/prodazhba`, query: { chlen: memberId } }}
              className={buttonVariants({ variant: 'primary' })}
            >
              {t('card.sell')}
            </Link>
          )}
          {actorCan(actor, 'payments.record') && member.owedCents > 0 && (
            <Link
              href={{ pathname: `${base}/plashtaniya`, query: { chlen: memberId } }}
              className={buttonVariants({ variant: 'secondary' })}
            >
              {t('card.recordPayment')}
            </Link>
          )}
          {actorCan(actor, 'members.manage') && (
            <Link
              href={`${base}/chlenove/${memberId}/redakcia`}
              className={buttonVariants({ variant: 'secondary' })}
            >
              {t('card.edit')}
            </Link>
          )}
        </div>
        {actorCan(actor, 'members.manage') && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {!member.link && member.email && !member.isMinor && (
              <form action={memberOpAction}>
                {op('invite')}
                <Button type="submit" variant="ghost" size="sm" title={t('card.link.inviteHint')}>
                  {t('card.link.invite')}
                </Button>
              </form>
            )}
            {member.link?.status === 'pending' && (
              <>
                <form action={memberOpAction}>
                  {op('approve')}
                  <Button type="submit" size="sm">
                    {t('card.link.approve')}
                  </Button>
                </form>
                <form action={memberOpAction}>
                  {op('decline')}
                  <Button type="submit" variant="ghost" size="sm">
                    {t('card.link.decline')}
                  </Button>
                </form>
              </>
            )}
            {member.link?.status === 'active' && (
              <form action={memberOpAction}>
                {op('unlink')}
                <Button type="submit" variant="ghost" size="sm">
                  {t('card.link.unlink')}
                </Button>
              </form>
            )}
            <form action={memberOpAction}>
              {op(member.archivedAt ? 'restore' : 'archive')}
              <Button type="submit" variant="ghost" size="sm">
                {member.archivedAt ? t('card.restore') : t('card.archive')}
              </Button>
            </form>
            {actorCan(actor, 'members.erase') && (
              <form action={memberOpAction}>
                {op('erase')}
                <ConfirmButton
                  className={buttonVariants({ variant: 'danger', size: 'sm' })}
                  message={t('card.eraseConfirm')}
                >
                  {t('card.erase')}
                </ConfirmButton>
              </form>
            )}
          </div>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={section}>
          <h2 className="text-h4 font-bold text-ink">{t('card.contact')}</h2>
          <dl className="space-y-1 text-body-sm">
            <div>
              <dt className="sr-only">{t('form.email')}</dt>
              <dd className="text-ink">{member.email ?? t('card.noEmail')}</dd>
            </div>
            <div>
              <dt className="sr-only">{t('form.phone')}</dt>
              <dd className="text-ink">{member.phone ?? t('card.noPhone')}</dd>
            </div>
          </dl>
          {member.guardianId && (
            <p className="text-body-sm">
              {t('card.guardian')}:{' '}
              <Link
                href={`${base}/chlenove/${member.guardianId}`}
                className="font-medium text-link"
              >
                {member.guardianName}
              </Link>
            </p>
          )}
          {member.children.length > 0 && (
            <p className="text-body-sm">
              {t('card.children')}:{' '}
              {member.children.map((child, index) => (
                <span key={child.id}>
                  {index > 0 && ', '}
                  <Link href={`${base}/chlenove/${child.id}`} className="font-medium text-link">
                    {child.displayName}
                  </Link>
                </span>
              ))}
            </p>
          )}
          {member.tags.length > 0 && (
            <p className="flex flex-wrap gap-1">
              {member.tags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))}
            </p>
          )}
          {member.staffNote && (
            <p className="whitespace-pre-line rounded-sm bg-paper-sunk p-2 text-body-sm text-ink">
              {member.staffNote}
            </p>
          )}
        </section>

        {actorCan(actor, 'members.manage') && !member.archivedAt && (
          <section className={section}>
            <h2 className="text-h4 font-bold text-ink">{t('card.card')}</h2>
            {member.hasCard && (
              <p className="text-caption text-text-muted">{t('card.cardExists')}</p>
            )}
            <IssueCardButton
              action={issueCardAction}
              slug={slug}
              memberId={memberId}
              labels={{
                submit: t('card.cardNew'),
                hint: t('card.cardHint'),
                keyTemplate: t('card.cardKey', { key: '{key}' }),
              }}
              messages={messages}
            />
          </section>
        )}
      </div>

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('card.memberships')}</h2>
        {member.memberships.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('card.noMemberships')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {member.memberships.map((ms) => {
              const live =
                ms.state === 'active' || ms.state === 'paused' || ms.state === 'upcoming';
              return (
                <li key={ms.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-ink">{ms.planName}</span>
                    <StatusBadge
                      kind={membershipKind(ms.state)}
                      label={tClub(`membershipState.${ms.state}`)}
                    />
                  </div>
                  <p className="text-caption text-text-muted">
                    {formatDate(ms.startsOn, locale)} – {formatDate(ms.effectiveEndsOn, locale)}
                    {ms.visitsRemaining !== null &&
                      ` · ${tClub('visitsLeft', { count: ms.visitsRemaining })}`}
                    {` · ${formatEuro(ms.priceCents, locale)}`}
                  </p>
                  {live && actorCan(actor, 'sales.manage') && (
                    <div className="flex flex-wrap items-end gap-2">
                      {ms.pausedToday ? (
                        <form action={memberOpAction}>
                          {op('resume', { membershipId: ms.id })}
                          <Button type="submit" variant="secondary" size="sm">
                            {t('card.resume')}
                          </Button>
                        </form>
                      ) : (
                        <form action={pauseAction} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="memberId" value={memberId} />
                          <input type="hidden" name="membershipId" value={ms.id} />
                          <label className="text-caption text-ink-soft">
                            {t('card.pauseFrom')}
                            <Input
                              name="startsOn"
                              type="date"
                              size="sm"
                              defaultValue={today}
                              required
                            />
                          </label>
                          <label className="text-caption text-ink-soft">
                            {t('card.pauseTo')}
                            <Input
                              name="endsOn"
                              type="date"
                              size="sm"
                              defaultValue={addDaysIso(today, 13)}
                              required
                            />
                          </label>
                          <Button type="submit" variant="secondary" size="sm">
                            {t('card.pause')}
                          </Button>
                        </form>
                      )}
                      <form action={memberOpAction} className="flex flex-wrap items-end gap-2">
                        {op('cancel', { membershipId: ms.id })}
                        <label className="text-caption text-ink-soft">
                          {t('card.cancelReason')}
                          <Select name="reason" size="sm" defaultValue="member_request">
                            {CLUB_CANCEL_REASONS.map((reason) => (
                              <option key={reason} value={reason}>
                                {tClub(`cancelReason.${reason}`)}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <Button type="submit" variant="ghost" size="sm">
                          {t('card.cancel')}
                        </Button>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {actorCan(actor, 'payments.view') && (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className={section}>
            <h2 className="text-h4 font-bold text-ink">{t('card.charges')}</h2>
            {member.charges.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('card.noCharges')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {member.charges.map((charge) => (
                  <li
                    key={charge.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="min-w-0 text-body-sm">
                      <span className="block font-medium text-ink">{charge.label}</span>
                      <span className="text-caption text-text-muted">
                        {formatEuro(charge.amountCents, locale)} ·{' '}
                        {formatDate(charge.dueOn, locale)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge
                        kind={chargeKind(charge.status)}
                        label={tClub(`chargeStatus.${charge.status}`)}
                      />
                      {charge.status !== 'void' && actorCan(actor, 'charges.void') && (
                        <form action={memberOpAction}>
                          {op('void', { chargeId: charge.id })}
                          <ConfirmButton
                            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                            message={t('card.voidConfirm')}
                          >
                            {t('card.void')}
                          </ConfirmButton>
                        </form>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={section}>
            <h2 className="text-h4 font-bold text-ink">{t('card.payments')}</h2>
            {member.payments.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('card.noPayments')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {member.payments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-body-sm"
                  >
                    <span>
                      <span className="block text-ink">{payment.chargeLabel}</span>
                      <span className="text-caption text-text-muted">
                        {formatDate(payment.receivedOn, locale)} ·{' '}
                        {tClub(`method.${payment.method}`)}
                        {payment.kind === 'refund' ? ` · ${t('card.refund')}` : ''}
                      </span>
                    </span>
                    <span className="font-mono tabular-nums text-ink">
                      {formatEuro(payment.amountCents, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('card.visits')}</h2>
        {member.visits.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('card.noVisits')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {member.visits.map((visit) => (
              <li
                key={visit.id}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-body-sm"
              >
                <span className="text-ink">
                  {visit.classTitle ?? t('card.openGym')} · {visit.location}
                  {!visit.covered && (
                    <span className="text-caption text-warning"> · {t('card.uncovered')}</span>
                  )}
                </span>
                <span className="text-caption text-text-muted">
                  {formatDateTime(visit.at, locale)} · {tClub(`checkinMethod.${visit.method}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {history.length > 0 && (
        <section className={section}>
          <h2 className="text-h4 font-bold text-ink">{t('card.history')}</h2>
          <ClubLog entries={history} />
        </section>
      )}
    </main>
  );
}
