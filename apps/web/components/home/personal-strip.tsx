import { getDb } from '@sportkarta/db';
import { CalendarClock, Flame, Medal } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { CurrentUser } from '@/lib/auth-session';
import { badgeArt } from '@/lib/design/badge-art';
import { homePersonal, type HomePersonal } from '@/lib/home/personal';
import { dayWord, whenParts } from '@/lib/home/when';

const TILE =
  'flex min-h-16 min-w-0 items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-150 ease-standard hover:bg-surface-2 focus-visible:shadow-[var(--ring)]';

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="mx-auto max-w-6xl px-4 pt-4 sm:px-6 lg:px-8">
      <div className="grid gap-1 rounded-card border border-line bg-surface p-1.5 shadow-sm sm:grid-cols-3 sm:items-stretch lg:grid-cols-[minmax(0,0.8fr)_repeat(3,minmax(0,1fr))]">
        {children}
      </div>
    </section>
  );
}

/**
 * The signed-in member's strip: next up, the week streak, the badges
 * (lib/home/personal.ts). Streamed behind a skeleton of the same size, so the
 * hero below does not jump when it lands; a failed load renders nothing rather
 * than taking the front page down with it.
 */
export async function PersonalStrip({ user, locale }: { user: CurrentUser; locale: string }) {
  const t = await getTranslations('Home.personal');
  let data: HomePersonal;
  try {
    data = await homePersonal(getDb(), user.id, locale);
  } catch (error: unknown) {
    console.error(
      '[home] personal strip failed:',
      error instanceof Error ? error.message : 'unknown',
    );
    return null;
  }

  const name = user.displayName.trim();
  const next = data.next;
  let when: string | null = null;
  if (next) {
    const [date, time] = whenParts(next.startsAtLocal, locale);
    const word = dayWord(next.startsAtLocal);
    when =
      word === 'today'
        ? t('nextToday', { time })
        : word === 'tomorrow'
          ? t('nextTomorrow', { time })
          : t('nextOn', { date, time });
  }

  return (
    <Shell label={t('label')}>
      <p className="flex items-center px-3 py-2.5 text-body font-bold text-ink sm:col-span-3 lg:col-span-1">
        {name ? t('greeting', { name }) : t('greetingNoName')}
      </p>

      <Link href={next?.href ?? '/sesii'} className={TILE}>
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-brand-subtle text-brand">
          <CalendarClock size={20} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-overline font-semibold uppercase tracking-overline text-text-muted">
            {t('next')}
          </span>
          {next ? (
            <>
              <span className="line-clamp-2 text-body-sm font-bold text-ink">
                {next.kind === 'club' ? `${next.club} · ${next.title}` : next.title}
              </span>
              <span className="line-clamp-2 text-caption text-ink-soft">
                {when}
                {next.place ? ` · ${next.place}` : ''}
              </span>
            </>
          ) : (
            <>
              <span className="line-clamp-2 text-body-sm font-bold text-ink">{t('nextEmpty')}</span>
              <span className="block text-caption text-link">{t('nextEmptyCta')}</span>
            </>
          )}
        </span>
      </Link>

      <Link href="/pasport" className={TILE}>
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-md ${
            data.streakWeeks > 0
              ? 'bg-accent-subtle text-accent-active'
              : 'bg-paper-sunk text-text-muted'
          }`}
        >
          <Flame size={20} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-overline font-semibold uppercase tracking-overline text-text-muted">
            {t('streak')}
          </span>
          <span className="line-clamp-2 text-body-sm font-bold text-ink">
            {t('streakWeeks', { count: data.streakWeeks })}
          </span>
          {data.streakWeeks > 0 && (
            <span
              className={`block text-caption ${data.weeksAtRisk ? 'text-warning' : 'text-ink-soft'}`}
            >
              {data.weeksAtRisk ? t('streakAtRisk') : t('streakKeep')}
            </span>
          )}
        </span>
      </Link>

      <Link href="/pasport" className={TILE}>
        {data.latestBadges.length > 0 ? (
          <span className="flex shrink-0 -space-x-3">
            {data.latestBadges.map((slug) => {
              const art = badgeArt(slug);
              return art ? (
                // eslint-disable-next-line @next/next/no-img-element -- a static brand SVG
                <img key={slug} src={art} alt="" width={40} height={40} className="size-10" />
              ) : null;
            })}
          </span>
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-paper-sunk text-text-muted">
            <Medal size={20} aria-hidden="true" />
          </span>
        )}
        <span className="min-w-0">
          <span className="block text-overline font-semibold uppercase tracking-overline text-text-muted">
            {t('badges')}
          </span>
          <span className="line-clamp-2 text-body-sm font-bold text-ink">
            {t('badgesCount', { earned: data.earned, total: data.total })}
          </span>
          <span className="block truncate font-mono text-caption tabular-nums text-ink-soft">
            {t('points', { count: data.points })}
          </span>
        </span>
      </Link>
    </Shell>
  );
}

/** The strip's footprint, shown while it streams in. */
export async function PersonalStripSkeleton() {
  const t = await getTranslations('Home.personal');
  return (
    <Shell label={t('label')}>
      <span className="min-h-16 rounded-md sm:col-span-3 lg:col-span-1" />
      {[0, 1, 2].map((key) => (
        <span key={key} className="flex min-h-16 items-center gap-3 px-3 py-2.5" aria-hidden="true">
          <span className="size-10 shrink-0 animate-pulse rounded-md bg-paper-sunk" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-2.5 w-16 animate-pulse rounded-pill bg-paper-sunk" />
            <span className="h-3 w-32 animate-pulse rounded-pill bg-paper-sunk" />
          </span>
        </span>
      ))}
    </Shell>
  );
}
