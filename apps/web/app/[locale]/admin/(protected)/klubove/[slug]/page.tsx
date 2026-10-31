import {
  CLUB_CONTRACT_BILLING,
  CLUB_CONTRACT_MONTHS,
  CLUB_CONTRACT_NOTICE_MONTHS,
  CLUB_TIERS,
  CLUB_TRIAL_DAYS,
  COMMUNITY_MEMBER_CAP,
  clubContractTerm,
  formatEuro,
  sofiaToday,
  tierFeatures,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AdminActionLog } from '@/components/admin/admin-action-log';
import { ClubStateBadge } from '@/components/clubs/club-state-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { adminActionHistory, CLUB_ACTIONS } from '@/lib/admin-actions';
import { requireRole } from '@/lib/auth-session';
import { adminClubDetail } from '@/lib/clubs/admin';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { formatDate, formatMonthYear } from '@/lib/format';

import {
  approveClubAction,
  purgeClubAction,
  rejectClubAction,
  setClubPlanAction,
  setClubStatusAction,
} from '../actions';

export const dynamic = 'force-dynamic';

const OUTCOMES = new Set(['saved', 'approved', 'rejected', 'unchanged', 'not_changed', 'not_yet']);
const ERRORS = new Set([
  'date_invalid',
  'cap_invalid',
  'sms_cap_invalid',
  'tier_invalid',
  'contract_incomplete',
  'notice_needs_contract',
  'notice_future',
  'invalid',
  'provider_error',
]);

export default async function AdminClubPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  await requireRole('admin');
  const club = await adminClubDetail(slug);
  if (!club) notFound();
  const { rezultat } = await searchParams;
  const [t, tClub, tLog, history] = await Promise.all([
    getTranslations('AdminClubs'),
    getTranslations('Club'),
    getTranslations('AdminAccounts.actionLog'),
    adminActionHistory({ clubId: club.id, actions: CLUB_ACTIONS }, 50),
  ]);
  const today = sofiaToday();
  const contract = clubContractTerm(
    { startsOn: club.contractStartsOn, noticeOn: club.contractNoticeOn },
    today,
  );
  const day = (date: string) => formatDate(date, locale);
  const hidden = (
    <>
      <input type="hidden" name="clubId" value={club.id} />
      <input type="hidden" name="slug" value={club.slug} />
    </>
  );
  const label = 'block text-body-sm font-semibold text-ink';

  return (
    <main className="space-y-6">
      <Link
        href="/admin/klubove"
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('back')}
      </Link>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{club.nameBg}</h1>
          <ClubStateBadge state={club.accessState} label={tClub(`state.${club.accessState}`)} />
        </div>
        <p className="text-body-sm text-ink-soft">
          {tClub(`kind.${club.kind}`)} · {tClub(`tier.${club.tier}`)} · /klub/{club.slug}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/klub/${club.slug}/tablo`}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            {t('openOffice')}
          </Link>
          {club.accessState !== 'pending' && club.visible && (
            <Link
              href={`/klub/${club.slug}`}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              {t('publicPage')}
            </Link>
          )}
        </div>
      </header>

      {rezultat && (OUTCOMES.has(rezultat) || ERRORS.has(rezultat)) && (
        <p
          role="status"
          className={`rounded-card border p-3 text-body-sm ${
            ERRORS.has(rezultat) ? 'border-danger text-danger' : 'border-line bg-surface text-ink'
          }`}
        >
          {rezultat === 'not_yet' && club.purgeableFrom
            ? t('purgeNotYet', { date: formatDate(club.purgeableFrom, locale) })
            : ERRORS.has(rezultat)
              ? t(rezultat === 'invalid' ? 'error.not_changed' : `error.${rezultat}`)
              : rezultat === 'not_changed' || rezultat === 'unchanged'
                ? t('error.not_changed')
                : t('saved')}
        </p>
      )}

      {club.status === 'pending' && (
        <section className="flex flex-wrap gap-3 rounded-card border border-line bg-surface p-4 shadow-sm">
          <form action={approveClubAction}>
            {hidden}
            <ConfirmButton
              className={buttonVariants({ variant: 'primary' })}
              message={t('approveConfirm', { days: CLUB_TRIAL_DAYS })}
            >
              {t('approve')}
            </ConfirmButton>
          </form>
          <form action={rejectClubAction}>
            {hidden}
            <ConfirmButton
              className={buttonVariants({ variant: 'secondary' })}
              message={t('rejectConfirm')}
            >
              {t('reject')}
            </ConfirmButton>
          </form>
        </section>
      )}

      <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
        <h2 className="text-h4 font-bold text-ink">{t('planTitle')}</h2>
        <p className="text-caption text-text-muted">{t('invoiceNote')}</p>
        <p className="text-caption text-ink-soft">
          {t('tierFeatures', { tier: tClub(`tier.${club.tier}`) })}{' '}
          {tierFeatures(club.tier).length === 0
            ? t('tierFeaturesNone')
            : tierFeatures(club.tier)
                .map((feature) => tClub(`feature.${feature}`))
                .join(', ')}
        </p>
        <form action={setClubPlanAction} className="grid gap-4 sm:grid-cols-2">
          {hidden}
          <div className="space-y-1">
            <label className={label} htmlFor="c-tier">
              {t('fieldTier')}
            </label>
            <Select id="c-tier" name="tier" defaultValue={club.tier}>
              {CLUB_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tClub(`tier.${tier}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="c-cap">
              {t('fieldMemberCap')}
            </label>
            <Input
              id="c-cap"
              name="memberCap"
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={club.memberCap ?? ''}
              aria-describedby="c-cap-hint"
            />
            <p id="c-cap-hint" className="text-caption text-text-muted">
              {t('memberCapHint', { cap: COMMUNITY_MEMBER_CAP })}
            </p>
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="c-sms">
              {t('fieldSmsCap')}
            </label>
            <Input
              id="c-sms"
              name="smsMonthlyCap"
              inputMode="numeric"
              pattern="[0-9]*"
              defaultValue={club.smsMonthlyCap}
              aria-describedby="c-sms-hint"
            />
            <p id="c-sms-hint" className="text-caption text-text-muted">
              {t('smsCapHint')}
            </p>
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="c-paid">
              {t('fieldPaidUntil')}
            </label>
            <Input id="c-paid" name="paidUntil" type="date" defaultValue={club.paidUntil ?? ''} />
          </div>
          <div className="space-y-1">
            <label className={label} htmlFor="c-trial">
              {t('fieldTrialEndsOn')}
            </label>
            <Input
              id="c-trial"
              name="trialEndsOn"
              type="date"
              defaultValue={club.trialEndsOn ?? ''}
            />
          </div>
          <div className="grid gap-4 border-t border-line pt-4 sm:col-span-2 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-3">
              <h3 className="text-body font-bold text-ink">{t('contractTitle')}</h3>
              <p className="text-caption text-text-muted">
                {t('contractNote', {
                  months: CLUB_CONTRACT_MONTHS,
                  notice: CLUB_CONTRACT_NOTICE_MONTHS,
                })}
              </p>
              <p className="text-body-sm font-semibold text-ink" data-testid="contract-state">
                {contract.state === 'running'
                  ? t('contractState.running', {
                      boundUntil: day(contract.boundUntil),
                      noticeBy: day(contract.noticeBy),
                      renewsOn: day(contract.renewsOn),
                    })
                  : contract.state === 'none'
                    ? t('contractState.none')
                    : t(`contractState.${contract.state}`, { endsOn: day(contract.endsOn) })}
              </p>
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="c-contract-start">
                {t('fieldContractStartsOn')}
              </label>
              <Input
                id="c-contract-start"
                name="contractStartsOn"
                type="date"
                defaultValue={club.contractStartsOn ?? ''}
              />
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="c-contract-billing">
                {t('fieldContractBilling')}
              </label>
              <Select
                id="c-contract-billing"
                name="contractBilling"
                defaultValue={club.contractBilling ?? ''}
              >
                <option value="">{t('billing.none')}</option>
                {CLUB_CONTRACT_BILLING.map((billing) => (
                  <option key={billing} value={billing}>
                    {t(`billing.${billing}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="c-contract-notice">
                {t('fieldContractNoticeOn')}
              </label>
              <Input
                id="c-contract-notice"
                name="contractNoticeOn"
                type="date"
                defaultValue={club.contractNoticeOn ?? ''}
              />
            </div>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit">{t('save')}</Button>
          </div>
        </form>
      </section>

      {club.status !== 'pending' && (
        <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
          <h2 className="text-h4 font-bold text-ink">{t('statusTitle')}</h2>
          <div className="flex flex-wrap gap-3">
            {club.status === 'active' && (
              <form action={setClubStatusAction}>
                {hidden}
                <input type="hidden" name="target" value="suspended" />
                <ConfirmButton
                  className={buttonVariants({ variant: 'secondary' })}
                  message={t('suspendConfirm')}
                >
                  {t('suspend')}
                </ConfirmButton>
              </form>
            )}
            {(club.status === 'suspended' || (club.status === 'archived' && club.approvedAt)) && (
              <form action={setClubStatusAction}>
                {hidden}
                <input type="hidden" name="target" value="active" />
                <Button type="submit" variant="secondary">
                  {t('reinstate')}
                </Button>
              </form>
            )}
            {(club.status === 'active' || club.status === 'suspended') && (
              <form action={setClubStatusAction}>
                {hidden}
                <input type="hidden" name="target" value="archived" />
                <ConfirmButton
                  className={buttonVariants({ variant: 'secondary' })}
                  message={t('archiveConfirm')}
                >
                  {t('archive')}
                </ConfirmButton>
              </form>
            )}
            {club.status === 'archived' && (
              <form action={purgeClubAction}>
                {hidden}
                <ConfirmButton
                  className={buttonVariants({ variant: 'danger' })}
                  message={t('purgeConfirm')}
                  disabled={!club.purgeableFrom || club.purgeableFrom > today}
                >
                  {t('purge')}
                </ConfirmButton>
                {club.purgeableFrom && club.purgeableFrom > today && (
                  <p className="mt-1 text-caption text-text-muted">
                    {t('purgeNotYet', { date: formatDate(club.purgeableFrom, locale) })}
                  </p>
                )}
              </form>
            )}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
          <h2 className="text-h4 font-bold text-ink">{t('countsTitle')}</h2>
          <dl className="grid grid-cols-2 gap-3">
            {(['members', 'liveMemberships', 'classes', 'checkins30', 'locations'] as const).map(
              (key) => (
                <div key={key}>
                  <dt className="text-caption text-text-muted">{t(`counts.${key}`)}</dt>
                  <dd className="font-mono text-h4 font-semibold tabular-nums text-ink">
                    {club.counts[key]}
                  </dd>
                </div>
              ),
            )}
          </dl>
        </section>

        <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
          <h2 className="text-h4 font-bold text-ink">{t('contactTitle')}</h2>
          <dl className="space-y-1 text-body-sm">
            {(
              [
                ['legalName', club.legalName],
                ['eik', club.eik],
                ['publicEmail', club.publicEmail],
                ['website', club.websiteUrl],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="w-36 shrink-0 text-text-muted">{t(key)}</dt>
                <dd className="min-w-0 break-words text-ink">{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
        <h2 className="text-h4 font-bold text-ink">{t('staffTitle')}</h2>
        {club.staff.length === 0 ? (
          <p className="font-semibold text-danger">{t('ownerless')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {club.staff.map((member) => (
              <li
                key={member.userId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <Link
                  href={`/admin/akaunti/${member.userId}`}
                  className="font-medium text-link hover:text-link-hover"
                >
                  {member.name || member.email}
                </Link>
                <span className="text-caption text-text-muted">
                  {tClub(`role.${member.role}`)} · {member.email}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
        <h2 className="text-h4 font-bold text-ink">{t('activityTitle')}</h2>
        {club.activity.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('activityEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="border-b border-line text-left text-caption text-text-muted">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('colMonth')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t('colActive')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t('colCheckins')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t('colRevenue')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {club.activity.map((row) => (
                  <tr key={row.month} className="border-b border-line last:border-0">
                    <td className="py-1.5 pr-3">{formatMonthYear(row.month, locale)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {row.membersActive}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {row.checkins}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {formatEuro(row.revenueCents, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
        <h2 className="text-h4 font-bold text-ink">{tLog('title')}</h2>
        <p className="text-caption text-text-muted">{tLog('note')}</p>
        <AdminActionLog entries={history} />
      </section>
    </main>
  );
}
