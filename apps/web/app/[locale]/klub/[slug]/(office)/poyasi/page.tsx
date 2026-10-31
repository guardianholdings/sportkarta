import { LADDER_NAME_MAX, RANK_TEMPLATE_KEYS } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { BeltChip } from '@/components/clubs/belt-chip';
import { RankProgressText } from '@/components/clubs/rank-progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { formErrorText } from '@/lib/clubs/form-error';
import { clubSportLabeler, clubSportOptions } from '@/lib/clubs/labels';
import { examReady, listLadders } from '@/lib/clubs/ranks';

import { saveLadderAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * «Пояси» (0056, wave G2): who is ready for an exam on every live ladder, the
 * club's ladders, and — for management — a new one, empty or from a template.
 * Every member of staff reads it; a trainer sees clients by name only.
 */
export default async function ClubRanksPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'ranks.view');
  const { rezultat } = await searchParams;
  const [t, messages, ladders, ready, sportLabel, sports] = await Promise.all([
    getTranslations('ClubRanks'),
    clubFormMessages(),
    listLadders(actor, locale),
    examReady(actor, locale),
    clubSportLabeler(),
    clubSportOptions(locale),
  ]);
  const canManage = actorCan(actor, 'ranks.manage');
  const canOpenCard = actorCan(actor, 'members.view');
  const base = `/klub/${slug}`;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const hint = 'mt-1 block text-caption font-normal text-text-muted';

  return (
    <main className="space-y-5">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      {rezultat && (
        <p
          role="status"
          className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
        >
          {rezultat === 'readOnly' ? messages.readOnly : formErrorText(messages, rezultat)}
        </p>
      )}

      <section className={section} aria-labelledby="ready-h">
        <div>
          <h2 id="ready-h" className="text-h4 font-bold text-ink">
            {t('readyTitle')}
          </h2>
          <p className="text-caption text-text-muted">{t('readyHint')}</p>
        </div>
        {ready.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('readyEmpty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {ready.map((row) => (
              <li
                key={`${row.ladderId}:${row.memberId}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-body-sm"
              >
                <span className="min-w-0 flex-1">
                  {canOpenCard ? (
                    <Link
                      href={`${base}/chlenove/${row.memberId}`}
                      className="font-semibold text-link hover:text-link-hover"
                    >
                      {row.memberName}
                    </Link>
                  ) : (
                    <span className="font-semibold text-ink">{row.memberName}</span>
                  )}
                  <span className="block text-caption text-text-muted">
                    <Link
                      href={`${base}/poyasi/${row.ladderId}`}
                      className="text-link hover:text-link-hover"
                    >
                      {row.ladderName}
                    </Link>{' '}
                    · <RankProgressText progress={row} locale={locale} />
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-caption text-ink">
                  <BeltChip {...row.current} />
                  {row.next && (
                    <>
                      <span aria-hidden="true">→</span>
                      <BeltChip {...row.next} />
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={section} aria-labelledby="ladders-h">
        <h2 id="ladders-h" className="text-h4 font-bold text-ink">
          {t('laddersTitle')}
        </h2>
        {ladders.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {ladders.map((ladder) => (
              <li key={ladder.id} className="py-2.5">
                <Link
                  href={`${base}/poyasi/${ladder.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body-sm font-semibold text-ink">{ladder.name}</span>
                    <span className="block text-caption text-text-muted">
                      {ladder.sport ? sportLabel(ladder.sport) : t('allSports')} ·{' '}
                      {t('ranksCount', { count: ladder.ranks })} ·{' '}
                      {t('studentsCount', { count: ladder.students })}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {ladder.archived && <Badge tone="neutral">{t('archived')}</Badge>}
                    {ladder.ready > 0 && (
                      <Badge tone="success">{t('readyCount', { count: ladder.ready })}</Badge>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <details className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <summary className="cursor-pointer text-h4 font-bold text-ink">{t('new')}</summary>
          <form action={saveLadderAction} className="mt-3 space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <label className={field}>
              {t('form.template')}
              <Select name="template" defaultValue="" className="mt-1">
                <option value="">{t('form.templateNone')}</option>
                {RANK_TEMPLATE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {t(`templates.${key}.name`)}
                  </option>
                ))}
              </Select>
              <span className={hint}>{t('form.templateHint')}</span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={field}>
                {t('form.nameBg')}
                <Input name="nameBg" maxLength={LADDER_NAME_MAX} className="mt-1" />
                <span className={hint}>{t('form.nameHint')}</span>
              </label>
              <label className={field}>
                {t('form.nameEn')}
                <Input name="nameEn" maxLength={LADDER_NAME_MAX} className="mt-1" />
              </label>
            </div>
            <label className={field}>
              {t('form.sport')}
              <Select name="sport" defaultValue="" className="mt-1">
                <option value="">{t('form.sportAll')}</option>
                {sports.map((sport) => (
                  <option key={sport.value} value={sport.value}>
                    {sport.label}
                  </option>
                ))}
              </Select>
              <span className={hint}>{t('form.sportHint')}</span>
            </label>
            <Button type="submit">{t('form.create')}</Button>
          </form>
        </details>
      )}
    </main>
  );
}
