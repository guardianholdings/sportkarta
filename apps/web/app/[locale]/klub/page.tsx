import { Building2, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { clubName, requireClubsEnabled } from '@/lib/clubs/club-session';
import { isOutcomeCode } from '@/lib/clubs/form-error';
import { claimableRecords } from '@/lib/clubs/links';
import { memberClubs } from '@/lib/clubs/portal';
import { clubsForStaff } from '@/lib/clubs/staff';
import { cn } from '@/lib/utils';

import { claimAction } from './actions';

export const dynamic = 'force-dynamic';

const GOOD = new Set(['claimed', 'declined', 'unlinked']);

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubHub' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The member's door into the club module, reached from /profil. Three lists
 * from three sources, none of them guessed: the offices this account holds a
 * staff grant in, the clubs where it has a linked record, and records that
 * carry its VERIFIED email and wait for «Това съм аз». Nothing here is added
 * to the primary navigation — the tab bar stays four tabs and the FAB.
 */
export default async function ClubHubPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const user = await requireUser();
  const { rezultat } = await searchParams;
  const [t, tClub, offices, memberships, claimable] = await Promise.all([
    getTranslations('ClubHub'),
    getTranslations('Club'),
    clubsForStaff(user.id),
    memberClubs(user.id, locale),
    claimableRecords(user.id),
  ]);
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const row =
    'flex min-h-11 flex-wrap items-center justify-between gap-2 py-2 text-body-sm focus-visible:shadow-[var(--ring)] focus-visible:outline-none';
  const empty = offices.length === 0 && memberships.length === 0 && claimable.length === 0;

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <header className="space-y-1 border-b border-line pb-3">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-body-sm text-ink-soft">{t('intro')}</p>
        </header>

        <div role="status" aria-live="polite">
          {isOutcomeCode(rezultat) && t.has(`outcome.${rezultat}`) && (
            <p
              className={cn(
                'rounded-card border p-3 text-body-sm text-ink',
                GOOD.has(rezultat)
                  ? 'border-success-border bg-success-bg'
                  : 'border-warning-border bg-warning-bg',
              )}
            >
              {t(`outcome.${rezultat}`)}
            </p>
          )}
        </div>

        {empty && <p className="text-body-sm text-text-muted">{t('empty')}</p>}

        {claimable.length > 0 && (
          <section className={section} aria-labelledby="claim-h">
            <h2 id="claim-h" className="text-h4 font-bold text-ink">
              {t('claimTitle')}
            </h2>
            <p className="text-body-sm text-ink-soft">{t('claimIntro')}</p>
            <ul className="divide-y divide-line">
              {claimable.map((record) => (
                <li key={record.memberId} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 text-body-sm font-medium text-ink">
                    {t('claimFor', { club: record.clubName, name: record.memberName })}
                  </span>
                  {(['claim', 'decline'] as const).map((decision) => (
                    <form key={decision} action={claimAction}>
                      <input type="hidden" name="memberId" value={record.memberId} />
                      <input type="hidden" name="decision" value={decision} />
                      <button
                        type="submit"
                        className={buttonVariants({
                          variant: decision === 'claim' ? 'primary' : 'secondary',
                          size: 'sm',
                        })}
                      >
                        {t(decision)}
                      </button>
                    </form>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        )}

        {offices.length > 0 && (
          <section className={section} aria-labelledby="offices-h">
            <h2 id="offices-h" className="text-h4 font-bold text-ink">
              {t('officesTitle')}
            </h2>
            <ul className="divide-y divide-line">
              {offices.map((office) => (
                <li key={office.slug}>
                  <Link href={`/klub/${office.slug}/tablo`} className={row}>
                    <span className="flex items-center gap-2 font-medium text-link">
                      <Building2 aria-hidden="true" className="size-4" />
                      {clubName(office, locale)}
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      <Badge tone="brand">{tClub(`role.${office.role}`)}</Badge>
                      {office.status !== 'active' && (
                        <Badge tone="warning">{tClub(`state.${office.status}`)}</Badge>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {memberships.length > 0 && (
          <section className={section} aria-labelledby="member-h">
            <h2 id="member-h" className="text-h4 font-bold text-ink">
              {t('membershipsTitle')}
            </h2>
            <ul className="divide-y divide-line">
              {memberships.map((membership) => (
                <li key={membership.memberId}>
                  <Link href={`/klub/${membership.clubSlug}/az`} className={row}>
                    <span className="font-medium text-link">{membership.clubName}</span>
                    {membership.status === 'pending' ? (
                      <Badge tone="warning">{t('pendingLink')}</Badge>
                    ) : (
                      <span className="text-caption text-text-muted">{t('portalOpen')}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-2 rounded-card border border-dashed border-line-strong p-4">
          <h2 className="text-body font-bold text-ink">{t('applyTitle')}</h2>
          <p className="text-body-sm text-ink-soft">{t('applyBody')}</p>
          <Link href="/klubove/zayavka" className={buttonVariants({ variant: 'secondary' })}>
            <Plus aria-hidden="true" />
            {t('apply')}
          </Link>
        </section>
      </main>
    </AppShell>
  );
}
