import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { BeltChip } from '@/components/clubs/belt-chip';
import { RankProgressText } from '@/components/clubs/rank-progress';
import { AppShell } from '@/components/shell/app-shell';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { portalView } from '@/lib/clubs/portal';
import { portalRanks } from '@/lib/clubs/ranks';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubRanks' });
  return { title: t('portal.title'), robots: { index: false, follow: false } };
}

/**
 * «Пояси» in the portal (0056): the belts of the account's own record and its
 * children's — the current rank on each ladder, how far the next one is, and
 * the history. Read-only: a rank is the coach's to award.
 */
export default async function PortalRanksPage({ params }: { params: PageParams }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const user = await requireUser();
  const view = await portalView(user.id, slug, locale);
  if (!view || view.link?.status !== 'active') notFound();
  const [t, ranks] = await Promise.all([
    getTranslations('ClubRanks'),
    portalRanks(user.id, view.club.id, locale),
  ]);
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const names = new Map<string, string>();
  for (const row of [...ranks.progress, ...ranks.history]) names.set(row.memberId, row.memberName);
  const recordIds = [
    ...new Set([
      ...ranks.progress.map((row) => row.memberId),
      ...ranks.history.map((a) => a.memberId),
    ]),
  ];

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-5 p-4">
        <header className="space-y-1 border-b border-line pb-3">
          <Link
            href={`/klub/${slug}/az`}
            className="text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {view.club.name}
          </Link>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('portal.title')}</h1>
          <p className="text-body-sm text-ink-soft">{t('portal.intro')}</p>
        </header>

        {recordIds.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('portal.empty')}</p>
        ) : (
          recordIds.map((memberId) => {
            const progress = ranks.progress.filter((row) => row.memberId === memberId);
            const history = ranks.history.filter((award) => award.memberId === memberId);
            const name = names.get(memberId);
            return (
              <section key={memberId} className={section} aria-label={name ?? t('portal.title')}>
                {name && recordIds.length > 1 && (
                  <h2 className="text-h4 font-bold text-ink">{name}</h2>
                )}
                <ul className="space-y-4">
                  {progress.map((row) => (
                    <li key={row.ladderId} className="space-y-1.5">
                      <p className="text-body font-semibold text-ink">{row.ladderName}</p>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink">
                        <BeltChip {...row.current} />
                        <span className="text-caption text-text-muted">
                          {t('progress.since', {
                            date: formatDate(row.awardedOn, locale, 'medium'),
                          })}
                        </span>
                      </p>
                      {row.next && (
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-soft">
                          <span>{t('portal.next')}</span>
                          <BeltChip {...row.next} />
                        </p>
                      )}
                      <RankProgressText
                        progress={row}
                        locale={locale}
                        className="block text-caption text-text-muted"
                      />
                      {row.ready && (
                        <p className="rounded-md border border-success-border bg-success-bg p-2 text-caption text-ink">
                          {t('portal.ready')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {history.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-caption font-semibold text-link">
                      {t('portal.history')}
                    </summary>
                    <ul className="mt-2 divide-y divide-line">
                      {history.map((award) => (
                        <li key={award.id} className="space-y-0.5 py-2 text-caption">
                          <BeltChip {...award.rank} className="text-ink" />
                          <span className="block text-text-muted">
                            {formatDate(award.awardedOn, locale, 'medium')} · {award.ladderName} ·{' '}
                            {t(`reasons.${award.reason}`)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            );
          })
        )}
      </main>
    </AppShell>
  );
}
