import { CLUB_ROLES, euroInputValue, formatEuro, grantableRoles } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { StaffInviteForm } from '@/components/clubs/team-forms';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { TIME_OFF_REASONS } from '@/lib/clubs/input';
import { clubTeam, upcomingTimeOff } from '@/lib/clubs/staff';
import { formatDate } from '@/lib/format';
import { formErrorText } from '@/lib/clubs/form-error';

import {
  changeRoleAction,
  inviteStaffAction,
  payAction,
  profileAction,
  removeStaffAction,
  removeTimeOffAction,
  revokeInviteAction,
  timeOffAction,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function ClubTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'staff.view');
  const canPay = actorCan(actor, 'staff.manage') && featureOn(club, 'staff_pay');
  const [t, tClub, messages, team, timeOff] = await Promise.all([
    getTranslations('ClubTeam'),
    getTranslations('Club'),
    clubFormMessages(),
    clubTeam(actor, canPay),
    upcomingTimeOff(actor),
  ]);
  const me = team.staff.find((member) => member.userId === actor.userId) ?? null;
  const field = 'block text-body-sm font-semibold text-ink';
  const { rezultat } = await searchParams;
  const manages = actorCan(actor, 'staff.manage');
  const granter = actor.role ?? 'owner';
  const grantable = actor.ngoAdmin ? CLUB_ROLES : grantableRoles(granter);
  const roleOptions = grantable.map((role) => ({ value: role, label: tClub(`role.${role}`) }));

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      {rezultat && rezultat !== 'saved' && (
        <p
          role="status"
          className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
        >
          {rezultat === 'readOnly' ? messages.readOnly : formErrorText(messages, rezultat)}
        </p>
      )}

      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <ul className="divide-y divide-line">
          {team.staff.map((member) => {
            const isSelf = member.userId === actor.userId;
            const canTouch = manages && (member.role !== 'owner' || grantable.includes('owner'));
            return (
              <li
                key={member.userId}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <span className="font-semibold text-ink">
                    {member.displayName || member.name || member.email}
                  </span>{' '}
                  {isSelf && <Badge tone="neutral">{t('you')}</Badge>}
                  <span className="block text-caption text-text-muted">
                    {tClub(`role.${member.role}`)} · {member.email}
                  </span>
                  <span className="block text-caption text-text-muted">
                    {t(`roles.${member.role}`)}
                  </span>
                </div>
                {member.pay && (
                  <form
                    action={payAction}
                    className="flex w-full flex-wrap items-end gap-2 sm:w-auto"
                  >
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="userId" value={member.userId} />
                    <label className="text-caption text-ink-soft">
                      {t('payKind')}
                      <Select name="payKind" size="sm" defaultValue={member.pay.kind}>
                        {(['none', 'flat', 'per_head', 'share'] as const).map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`pay.${kind}`)}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="text-caption text-ink-soft">
                      {t('payAmount')}
                      <Input
                        name="payAmount"
                        size="sm"
                        inputMode="decimal"
                        className="w-24"
                        defaultValue={
                          member.pay.cents === null ? '' : euroInputValue(member.pay.cents, locale)
                        }
                      />
                    </label>
                    <label className="text-caption text-ink-soft">
                      {t('payShare')}
                      <Input
                        name="payShare"
                        size="sm"
                        inputMode="decimal"
                        className="w-20"
                        defaultValue={
                          member.pay.shareBp === null ? '' : String(member.pay.shareBp / 100)
                        }
                      />
                    </label>
                    <Button type="submit" variant="secondary" size="sm">
                      {t('paySave')}
                    </Button>
                    {member.pay.kind !== 'none' && (
                      <span className="text-caption text-text-muted">
                        {member.pay.kind === 'share'
                          ? t('payShareNow', { percent: (member.pay.shareBp ?? 0) / 100 })
                          : t(`payNow.${member.pay.kind}`, {
                              amount: formatEuro(member.pay.cents ?? 0, locale),
                            })}
                      </span>
                    )}
                  </form>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {canTouch && !isSelf && (
                    <form action={changeRoleAction} className="flex items-center gap-2">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="userId" value={member.userId} />
                      <Select
                        name="role"
                        defaultValue={member.role}
                        aria-label={t('changeRole')}
                        size="sm"
                      >
                        {roleOptions.map((role) => (
                          <option key={role.value} value={role.value}>
                            {role.label}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit" variant="secondary" size="sm">
                        {t('changeRole')}
                      </Button>
                    </form>
                  )}
                  {(isSelf || canTouch) && (
                    <form action={removeStaffAction}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="userId" value={member.userId} />
                      <ConfirmButton
                        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                        message={isSelf ? t('leaveConfirm') : t('removeConfirm')}
                      >
                        {isSelf ? t('leave') : t('remove')}
                      </ConfirmButton>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {me && (
        <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
          <h2 className="text-h4 font-bold text-ink">{t('profileTitle')}</h2>
          <p className="text-caption text-ink-soft">{t('profileIntro')}</p>
          <form action={profileAction} className="space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <label className={field}>
              {t('profileName')}
              <Input
                name="displayName"
                maxLength={80}
                defaultValue={me.displayName ?? ''}
                className="mt-1"
              />
            </label>
            <label className={field}>
              {t('profileBio')}
              <Textarea
                name="bio"
                maxLength={1000}
                rows={3}
                defaultValue={me.bio ?? ''}
                className="mt-1"
              />
            </label>
            <label className="flex min-h-11 items-start gap-3 text-body-sm text-ink">
              <input
                type="checkbox"
                name="publicProfile"
                defaultChecked={me.publicProfile}
                className="mt-1 size-4 accent-[var(--brand)]"
              />
              {t('profilePublic')}
            </label>
            <Button type="submit" variant="secondary">
              {t('profileSave')}
            </Button>
          </form>
        </section>
      )}

      <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
        <h2 className="text-h4 font-bold text-ink">{t('timeOffTitle')}</h2>
        {timeOff.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('timeOffNone')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {timeOff.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-body-sm text-ink">
                  <span className="font-semibold">{entry.name}</span> ·{' '}
                  {entry.startsOn === entry.endsOn
                    ? formatDate(entry.startsOn, locale)
                    : `${formatDate(entry.startsOn, locale)} – ${formatDate(entry.endsOn, locale)}`}{' '}
                  · <span className="text-text-muted">{t(`timeOffReason.${entry.reason}`)}</span>
                </span>
                {(entry.userId === actor.userId || manages) && (
                  <form action={removeTimeOffAction}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="blockId" value={entry.id} />
                    <Button type="submit" variant="ghost" size="sm">
                      {t('timeOffRemove')}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        <form action={timeOffAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="slug" value={slug} />
          {manages ? (
            <label className="text-caption text-ink-soft">
              {t('timeOffWho')}
              <Select name="userId" size="sm" defaultValue={actor.userId}>
                {team.staff.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName || member.name || member.email}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <input type="hidden" name="userId" value={actor.userId} />
          )}
          <label className="text-caption text-ink-soft">
            {t('timeOffFrom')}
            <Input type="date" name="startsOn" size="sm" required />
          </label>
          <label className="text-caption text-ink-soft">
            {t('timeOffTo')}
            <Input type="date" name="endsOn" size="sm" />
          </label>
          <label className="text-caption text-ink-soft">
            {t('timeOffWhy')}
            <Select name="reason" size="sm" defaultValue="time_off">
              {TIME_OFF_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {t(`timeOffReason.${reason}`)}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="secondary" size="sm">
            {t('timeOffAdd')}
          </Button>
        </form>
      </section>

      {manages && (
        <>
          <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
            <h2 className="text-h4 font-bold text-ink">{t('inviteTitle')}</h2>
            <StaffInviteForm
              action={inviteStaffAction}
              slug={slug}
              roles={roleOptions}
              labels={{ email: t('inviteEmail'), role: t('inviteRole'), submit: t('invite') }}
              messages={{ ...messages, saved: t('invited') }}
            />
          </section>
          {team.invites.length > 0 && (
            <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm">
              <h2 className="text-h4 font-bold text-ink">{t('pendingTitle')}</h2>
              <ul className="divide-y divide-line">
                {team.invites.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="text-body-sm text-ink">
                      {invite.email} · {tClub(`role.${invite.role}`)} ·{' '}
                      <span className="text-text-muted">
                        {t('expires', { date: formatDate(invite.expiresAt, locale) })}
                      </span>
                    </span>
                    <form action={revokeInviteAction}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="inviteId" value={invite.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        {t('revoke')}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
