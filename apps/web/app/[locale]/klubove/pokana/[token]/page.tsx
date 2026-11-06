import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AppShell } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { memberInviteByToken } from '@/lib/clubs/links';
import { staffInviteByToken } from '@/lib/clubs/staff';
import { signInHref } from '@/lib/sign-in-destination';

import { acceptInviteAction } from './actions';

/**
 * An invitation from a club — to its team, or to link a member record. The
 * page says who invites to what and to which address; the address is shown
 * so a person signed in with another one knows why accepting will not work.
 * noindex: a token URL.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; token: string }>;

const INVITE_ERRORS = new Set(['invalid', 'wrong_account', 'already_linked']);

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubInvite' });
  return {
    title: t('title'),
    robots: { index: false, follow: false },
    // The token stays out of the next page's referrer.
    referrer: 'no-referrer',
  };
}

export default async function ClubInvitePage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ greshka?: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const { greshka } = await searchParams;
  const [t, tClub] = await Promise.all([getTranslations('ClubInvite'), getTranslations('Club')]);
  const staff = await staffInviteByToken(token);
  const member = staff ? null : await memberInviteByToken(token);
  const invite = staff ?? member;
  const user = invite?.usable ? await getCurrentUser() : null;

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-md space-y-4 p-4">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        {!invite || !invite.usable ? (
          <p className="rounded-card border border-warning-border bg-warning-bg p-3 text-body-sm text-ink">
            {t('invalid')}
          </p>
        ) : (
          <>
            <p className="text-body text-ink">
              {staff
                ? t('staff', { club: staff.clubName, role: tClub(`role.${staff.role}`) })
                : t('member', { club: member?.clubName ?? '', name: member?.memberName ?? '' })}
            </p>
            {member && <p className="text-body-sm text-ink-soft">{t('memberBenefits')}</p>}
            <p className="text-body-sm text-ink-soft">{t('forEmail', { email: invite.email })}</p>
            <div role="status" aria-live="polite">
              {greshka && INVITE_ERRORS.has(greshka) && (
                <p className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink">
                  {t(greshka)}
                </p>
              )}
            </div>
            {user ? (
              <form action={acceptInviteAction}>
                <input type="hidden" name="token" value={token} />
                <Button type="submit" block>
                  {t('accept')}
                </Button>
              </form>
            ) : (
              <Link
                href={signInHref(`/klubove/pokana/${token}`)}
                className="font-semibold text-link hover:text-link-hover"
              >
                {t('signIn')}
              </Link>
            )}
          </>
        )}
      </main>
    </AppShell>
  );
}
