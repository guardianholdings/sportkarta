import { CLUB_ROLES, grantableRoles } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { StaffInviteForm } from '@/components/clubs/team-forms';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Select } from '@/components/ui/select';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { clubTeam } from '@/lib/clubs/staff';
import { formatDate } from '@/lib/format';

import {
  changeRoleAction,
  inviteStaffAction,
  removeStaffAction,
  revokeInviteAction,
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
  const { actor } = await requireClubStaff(slug, 'staff.view');
  const [t, tClub, messages, team] = await Promise.all([
    getTranslations('ClubTeam'),
    getTranslations('Club'),
    clubFormMessages(),
    clubTeam(actor),
  ]);
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
          {messages.errors[rezultat] ?? messages.genericError}
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
