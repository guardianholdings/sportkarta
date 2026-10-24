import { verifyClubToken } from '@sportkarta/lib/checkin-token';
import { formatEuro } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { StatusBadge, memberKind } from '@/components/clubs/club-state-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { checkinSecret } from '@/lib/checkin-config';
import { todaysCheckins } from '@/lib/clubs/checkin';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { memberSummary } from '@/lib/clubs/members';
import { formatDate } from '@/lib/format';

import { scanCheckinAction } from '../../prisastviya/actions';

/**
 * What the desk's camera opens when it reads a member's personal QR
 * (`v2~mem~<club_members.id>~window~sig`, shown in the member's portal). The
 * token names a club record, never an account, and only resolves inside the
 * club whose staff is signed in — another club's member reads as "no such
 * member here". The page verifies to SHOW; the action verifies again to WRITE.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string; token: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubCheckin.scan' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

function decoded(token: string): string {
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

export default async function ClubScanPage({ params }: { params: PageParams }) {
  const { locale, slug, token: raw } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'attendance.record');
  const t = await getTranslations('ClubCheckin');
  const tClub = await getTranslations('Club');
  const token = decoded(raw);
  const secret = checkinSecret();
  const verified = secret ? verifyClubToken(token, secret, 'mem') : null;
  const member = verified?.ok ? await memberSummary(actor, verified.id) : null;
  const marked = member
    ? (await todaysCheckins(actor)).some((row) => row.memberId === member.id)
    : false;

  const problem = !secret
    ? t('scan.disabled')
    : !verified?.ok
      ? verified?.reason === 'expired'
        ? t('scan.expired')
        : t('scan.invalid')
      : !member
        ? t('scan.unknown')
        : null;

  return (
    <main className="mx-auto max-w-md space-y-4">
      <Link
        href={`/klub/${slug}/prisastviya`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('scan.back')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('scan.title')}</h1>

      {problem || !member ? (
        <p
          role="status"
          className="rounded-card border border-warning-border bg-warning-bg p-4 text-body text-ink"
        >
          {problem}
        </p>
      ) : (
        <section className="space-y-4 rounded-card border border-line bg-surface p-5 shadow-sm">
          <div className="space-y-2">
            <p className="text-h3 font-bold text-ink">
              {member.displayName}{' '}
              {member.isMinor && <Badge tone="neutral">{tClub('minor')}</Badge>}
            </p>
            <p className="flex flex-wrap items-center gap-1.5">
              <StatusBadge
                kind={memberKind(member.status)}
                label={tClub(`memberStatus.${member.status}`)}
              />
              {member.validUntil && (
                <span className="text-body-sm text-ink-soft">
                  {tClub('validUntil', { date: formatDate(member.validUntil, locale) })}
                </span>
              )}
              {member.visitsRemaining !== null && (
                <span className="text-body-sm text-ink-soft">
                  {tClub('visitsLeft', { count: member.visitsRemaining })}
                </span>
              )}
              {member.owedCents > 0 && (
                <StatusBadge
                  kind={member.overdue ? 'bad' : 'warning'}
                  label={formatEuro(member.owedCents, locale)}
                />
              )}
            </p>
          </div>
          {marked ? (
            <Badge tone="success">{t('markedToday')}</Badge>
          ) : (
            <form action={scanCheckinAction}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="token" value={token} />
              <Button type="submit" block className="min-h-12 text-body">
                {t('scan.confirm')}
              </Button>
            </form>
          )}
          <Link
            href={`/klub/${slug}/chlenove/${member.id}`}
            className="inline-flex min-h-11 items-center text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {t('scan.toCard')}
          </Link>
        </section>
      )}
    </main>
  );
}
