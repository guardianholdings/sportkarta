import {
  BELT_COLOURS,
  LADDER_NAME_MAX,
  RANK_ATTENDANCES_MAX,
  RANK_AWARD_REASONS,
  RANK_MONTHS_MAX,
  RANK_NAME_MAX,
  RANK_STRIPES_MAX,
  RANKS_PER_LADDER_MAX,
  can,
  sofiaToday,
  type RankAwardReason,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { BeltChip } from '@/components/clubs/belt-chip';
import { RankProgressText } from '@/components/clubs/rank-progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { formErrorText } from '@/lib/clubs/form-error';
import { isUuid } from '@/lib/clubs/input';
import { clubSportLabeler, clubSportOptions } from '@/lib/clubs/labels';
import {
  ladderCandidates,
  ladderForStaff,
  ladderStudents,
  type LadderRank,
} from '@/lib/clubs/ranks';
import { formatDate } from '@/lib/format';

import {
  archiveLadderAction,
  awardNextAction,
  awardOneAction,
  moveRankAction,
  removeRankAction,
  revokeAwardAction,
  saveLadderAction,
  saveRankAction,
} from '../actions';

export const dynamic = 'force-dynamic';

const GOOD = new Set([
  'created',
  'saved',
  'archived',
  'restored',
  'rankSaved',
  'rankMoved',
  'rankRemoved',
  'awarded',
  'awardedOne',
  'revoked',
]);

function count(raw: string | undefined): number {
  return raw !== undefined && /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
}

/**
 * One ladder (0056): its clients with their current rank and how far the next
 * one is — ticked and awarded together after an exam; who trained in its sport
 * lately without a rank yet (started on the first one); and its ranks, which
 * management orders, colours and gives what they ask. A trainer sees clients
 * by name only.
 */
export default async function ClubLadderPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string; ladderId: string }>;
  searchParams: Promise<{ rezultat?: string; n?: string; skip?: string }>;
}) {
  const { locale, slug, ladderId } = await params;
  setRequestLocale(locale);
  if (!isUuid(ladderId)) notFound();
  const { actor } = await requireClubStaff(slug, 'ranks.view');
  const [t, messages, ladder, students, candidates, sportLabel, sports] = await Promise.all([
    getTranslations('ClubRanks'),
    clubFormMessages(),
    ladderForStaff(actor, ladderId, locale),
    ladderStudents(actor, ladderId, locale),
    ladderCandidates(actor, ladderId),
    clubSportLabeler(),
    clubSportOptions(locale),
  ]);
  if (!ladder) notFound();
  const { rezultat, n, skip } = await searchParams;
  const good = rezultat !== undefined && GOOD.has(rezultat);
  const canManage = actorCan(actor, 'ranks.manage');
  // The club's own staff grade — never an NGO admin (0056).
  // The STAFF role decides, never actorCan's NGO-admin shortcut: the SQL
  // (clubStaffWriteScope) asks for the role.
  const canAward = actor.role !== null && can(actor.role, 'ranks.award') && !ladder.archived;
  const canOpenCard = actorCan(actor, 'members.view');
  const today = sofiaToday();
  const first = ladder.rankList[0] ?? null;
  const base = `/klub/${slug}`;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const small = 'block text-caption text-ink-soft';
  const hint = 'mt-1 block text-caption font-normal text-text-muted';
  const quiet =
    'min-h-11 rounded-pill border border-line-strong px-4 text-body-sm font-semibold text-ink hover:bg-surface-2';

  const outcome = !rezultat
    ? null
    : !good
      ? rezultat === 'readOnly'
        ? messages.readOnly
        : formErrorText(messages, rezultat)
      : rezultat === 'awarded'
        ? [
            t('outcome.awarded', { count: count(n) }),
            count(skip) > 0 ? t('outcome.skipped', { count: count(skip) }) : '',
          ]
            .filter(Boolean)
            .join(' ')
        : t(`outcome.${rezultat}`);

  const asks = (rank: LadderRank): string => {
    const parts: string[] = [];
    if (rank.minAttendances !== null) {
      parts.push(t('rank.attendances', { count: rank.minAttendances }));
    }
    if (rank.minMonths !== null) parts.push(t('rank.months', { count: rank.minMonths }));
    return parts.length === 0 ? t('rank.asksNothing') : t('rank.asks', { what: parts.join(' · ') });
  };

  const awardFields = (defaultReason: RankAwardReason) => (
    <div className="flex flex-wrap items-end gap-2">
      <label className={small}>
        {t('award.date')}
        <Input
          type="date"
          name="awardedOn"
          defaultValue={today}
          max={today}
          size="sm"
          required
          className="mt-1"
        />
      </label>
      <label className={small}>
        {t('award.reason')}
        <Select name="reason" defaultValue={defaultReason} size="sm" className="mt-1">
          {RANK_AWARD_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {t(`reasons.${reason}`)}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );

  const rankFields = (rank: LadderRank | null) => (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="ladderId" value={ladder.id} />
      {rank && <input type="hidden" name="rankId" value={rank.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          {t('rankForm.nameBg')}
          <Input
            name="nameBg"
            required
            maxLength={RANK_NAME_MAX}
            defaultValue={rank?.nameBg}
            className="mt-1"
          />
        </label>
        <label className={field}>
          {t('rankForm.nameEn')}
          <Input
            name="nameEn"
            maxLength={RANK_NAME_MAX}
            defaultValue={rank?.nameEn ?? ''}
            className="mt-1"
          />
        </label>
        <label className={field}>
          {t('rankForm.colour')}
          <Select name="colour" defaultValue={rank?.colour ?? 'white'} className="mt-1">
            {BELT_COLOURS.map((colour) => (
              <option key={colour} value={colour}>
                {t(`colours.${colour}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className={field}>
          {t('rankForm.accent')}
          <Select name="accent" defaultValue={rank?.accent ?? ''} className="mt-1">
            <option value="">{t('rankForm.accentNone')}</option>
            {BELT_COLOURS.map((colour) => (
              <option key={colour} value={colour}>
                {t(`colours.${colour}`)}
              </option>
            ))}
          </Select>
          <span className={hint}>{t('rankForm.accentHint')}</span>
        </label>
        <label className={field}>
          {t('rankForm.stripes')}
          <Input
            type="number"
            name="stripes"
            min={0}
            max={RANK_STRIPES_MAX}
            defaultValue={rank?.stripes ?? 0}
            className="mt-1"
          />
          <span className={hint}>{t('rankForm.stripesHint')}</span>
        </label>
        <label className={field}>
          {t('rankForm.minAttendances')}
          <Input
            type="number"
            name="minAttendances"
            min={1}
            max={RANK_ATTENDANCES_MAX}
            defaultValue={rank?.minAttendances ?? ''}
            className="mt-1"
          />
          <span className={hint}>{t('rankForm.minAttendancesHint')}</span>
        </label>
        <label className={field}>
          {t('rankForm.minMonths')}
          <Input
            type="number"
            name="minMonths"
            min={1}
            max={RANK_MONTHS_MAX}
            defaultValue={rank?.minMonths ?? ''}
            className="mt-1"
          />
          <span className={hint}>{t('rankForm.minMonthsHint')}</span>
        </label>
      </div>
    </>
  );

  return (
    <main className="space-y-5">
      <div>
        <Link
          href={`${base}/poyasi`}
          className="text-body-sm font-semibold text-link hover:text-link-hover"
        >
          ← {t('back')}
        </Link>
        <h1 className="mt-1 text-h2 font-extrabold tracking-tight text-ink">{ladder.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-body-sm text-ink-soft">
          {ladder.sport ? sportLabel(ladder.sport) : t('allSports')} ·{' '}
          {t('ranksCount', { count: ladder.ranks })} ·{' '}
          {t('studentsCount', { count: ladder.students })}
          {ladder.archived && <Badge tone="neutral">{t('archived')}</Badge>}
        </p>
      </div>

      {outcome && (
        <p
          role="status"
          className={
            good
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {outcome}
        </p>
      )}

      <section className={section} aria-labelledby="students-h">
        <h2 id="students-h" className="text-h4 font-bold text-ink">
          {t('students.title', { count: students.length })}
        </h2>
        {students.length === 0 ? (
          <p className="text-body-sm text-text-muted">
            {ladder.archived ? t('students.archived') : t('students.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {students.map((row) => (
              <li key={row.memberId} className="space-y-2 py-3">
                <div className="flex items-start gap-3">
                  {canAward && row.next && (
                    <label className="-m-3 flex min-h-11 min-w-11 shrink-0 items-start justify-center p-3">
                      <input
                        type="checkbox"
                        name="pick"
                        form="exam-award"
                        value={`${row.memberId}.${row.next.id}`}
                        aria-label={t('award.pick', { name: row.memberName, rank: row.next.name })}
                        className="size-5 accent-[var(--brand)]"
                      />
                    </label>
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-body-sm">
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
                      {row.ready && <Badge tone="success">{t('progress.readyBadge')}</Badge>}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink">
                      <BeltChip {...row.current} />
                      <span className="text-text-muted">
                        {t('progress.since', {
                          date: formatDate(row.awardedOn, locale, 'medium'),
                        })}
                      </span>
                      {row.next && (
                        <>
                          <span aria-hidden="true">→</span>
                          <BeltChip {...row.next} />
                        </>
                      )}
                    </p>
                    <RankProgressText
                      progress={row}
                      locale={locale}
                      className="block text-caption text-text-muted"
                    />
                  </div>
                </div>
                {canAward && (
                  <details className="rounded-md border border-line p-2">
                    <summary className="flex min-h-11 cursor-pointer items-center text-caption font-semibold text-link">
                      {t('award.other')}
                    </summary>
                    <form action={awardOneAction} className="mt-2 space-y-2">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="memberId" value={row.memberId} />
                      <input type="hidden" name="ladderId" value={ladder.id} />
                      <label className={small}>
                        {t('award.rank')}
                        <Select
                          name="rankId"
                          required
                          defaultValue={row.next?.id ?? ''}
                          size="sm"
                          className="mt-1"
                        >
                          <option value="" disabled>
                            {t('award.rank')}
                          </option>
                          {ladder.rankList.map((rank) => (
                            <option key={rank.id} value={rank.id}>
                              {rank.name}
                            </option>
                          ))}
                        </Select>
                      </label>
                      {awardFields('exam')}
                      <Button type="submit" size="sm">
                        {t('award.submitOne')}
                      </Button>
                    </form>
                    <form action={revokeAwardAction} className="mt-3">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="memberId" value={row.memberId} />
                      <input type="hidden" name="ladderId" value={ladder.id} />
                      <input type="hidden" name="awardId" value={row.awardId} />
                      <ConfirmButton message={t('award.revokeConfirm')} className={quiet}>
                        {t('award.revokeLast')}
                      </ConfirmButton>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {canAward && students.some((row) => row.next !== null) && (
          <form
            id="exam-award"
            action={awardNextAction}
            className="space-y-2 rounded-md border border-line bg-surface-2 p-3"
          >
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="ladderId" value={ladder.id} />
            <h3 className="text-body-sm font-bold text-ink">{t('award.title')}</h3>
            <p className="text-caption text-text-muted">{t('award.hint')}</p>
            {awardFields('exam')}
            <p className="text-caption text-text-muted">{t('reasonHint')}</p>
            <Button type="submit" size="sm">
              {t('award.submit')}
            </Button>
          </form>
        )}
      </section>

      {!ladder.archived && (
        <section className={section} aria-labelledby="candidates-h">
          <h2 id="candidates-h" className="text-h4 font-bold text-ink">
            {t('candidates.title')}
          </h2>
          {!first ? (
            <p className="text-body-sm text-text-muted">{t('candidates.noRanks')}</p>
          ) : candidates.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('candidates.empty')}</p>
          ) : (
            <>
              <p className="text-caption text-text-muted">
                {t('candidates.hint', { name: first.name })}
              </p>
              <ul className="divide-y divide-line">
                {candidates.map((candidate) => (
                  <li key={candidate.memberId} className="flex items-start gap-3 py-2.5">
                    {canAward && (
                      <label className="-m-3 flex min-h-11 min-w-11 shrink-0 items-start justify-center p-3">
                        <input
                          type="checkbox"
                          name="pick"
                          form="start-award"
                          value={`${candidate.memberId}.${first.id}`}
                          aria-label={t('award.pick', {
                            name: candidate.memberName,
                            rank: first.name,
                          })}
                          className="size-5 accent-[var(--brand)]"
                        />
                      </label>
                    )}
                    <span className="min-w-0 flex-1 text-body-sm">
                      {canOpenCard ? (
                        <Link
                          href={`${base}/chlenove/${candidate.memberId}`}
                          className="font-semibold text-link hover:text-link-hover"
                        >
                          {candidate.memberName}
                        </Link>
                      ) : (
                        <span className="font-semibold text-ink">{candidate.memberName}</span>
                      )}
                      <span className="block text-caption text-text-muted">
                        {t('candidates.visits', {
                          count: candidate.visits,
                          date: formatDate(candidate.lastSeen, locale, 'medium'),
                        })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {canAward && (
                <form
                  id="start-award"
                  action={awardNextAction}
                  className="space-y-2 rounded-md border border-line bg-surface-2 p-3"
                >
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="ladderId" value={ladder.id} />
                  {awardFields('promotion')}
                  <Button type="submit" size="sm">
                    {t('candidates.submit')}
                  </Button>
                </form>
              )}
            </>
          )}
        </section>
      )}

      <section className={section} aria-labelledby="ranks-h">
        <h2 id="ranks-h" className="text-h4 font-bold text-ink">
          {t('ranksTitle')}
        </h2>
        {ladder.rankList.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('ranksEmpty')}</p>
        ) : (
          <ol className="divide-y divide-line">
            {ladder.rankList.map((rank, index) => (
              <li key={rank.id} className="space-y-2 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="w-6 text-caption tabular-nums text-text-muted">
                    {index + 1}.
                  </span>
                  <BeltChip {...rank} className="flex-1 text-body-sm font-semibold text-ink" />
                  <span className="text-caption text-text-muted">
                    {t('rank.holders', { count: rank.holders })}
                  </span>
                </div>
                <p className="text-caption text-text-muted">
                  {index === 0 ? t('rank.first') : asks(rank)}
                </p>
                {canManage && (
                  <div className="flex flex-wrap items-center gap-2">
                    {index > 0 && (
                      <form action={moveRankAction}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="ladderId" value={ladder.id} />
                        <input type="hidden" name="rankId" value={rank.id} />
                        <input type="hidden" name="direction" value="up" />
                        <Button
                          type="submit"
                          size="sm"
                          variant="secondary"
                          aria-label={t('rank.upLabel', { name: rank.name })}
                        >
                          {t('rank.up')}
                        </Button>
                      </form>
                    )}
                    {index < ladder.rankList.length - 1 && (
                      <form action={moveRankAction}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="ladderId" value={ladder.id} />
                        <input type="hidden" name="rankId" value={rank.id} />
                        <input type="hidden" name="direction" value="down" />
                        <Button
                          type="submit"
                          size="sm"
                          variant="secondary"
                          aria-label={t('rank.downLabel', { name: rank.name })}
                        >
                          {t('rank.down')}
                        </Button>
                      </form>
                    )}
                    {rank.awarded ? (
                      <span className="text-caption text-text-muted">{t('rank.awardedHint')}</span>
                    ) : (
                      <form action={removeRankAction}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="ladderId" value={ladder.id} />
                        <input type="hidden" name="rankId" value={rank.id} />
                        <ConfirmButton message={t('rank.removeConfirm')} className={quiet}>
                          {t('rank.remove')}
                        </ConfirmButton>
                      </form>
                    )}
                  </div>
                )}
                {canManage && (
                  <details className="rounded-md border border-line p-2">
                    <summary className="flex min-h-11 cursor-pointer items-center text-caption font-semibold text-link">
                      {t('rank.edit')}
                    </summary>
                    <form action={saveRankAction} className="mt-2 space-y-3">
                      {rankFields(rank)}
                      <Button type="submit" size="sm">
                        {t('rankForm.save')}
                      </Button>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
        {canManage && !ladder.archived && ladder.rankList.length < RANKS_PER_LADDER_MAX && (
          <details className="rounded-md border border-line p-3">
            <summary className="cursor-pointer text-body-sm font-semibold text-link">
              {t('rankForm.add')}
            </summary>
            <form action={saveRankAction} className="mt-3 space-y-3">
              {rankFields(null)}
              <Button type="submit">{t('rankForm.add')}</Button>
            </form>
          </details>
        )}
      </section>

      {canManage && (
        <details className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <summary className="cursor-pointer text-h4 font-bold text-ink">{t('settings')}</summary>
          <form action={saveLadderAction} className="mt-3 space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="ladderId" value={ladder.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={field}>
                {t('form.nameBg')}
                <Input
                  name="nameBg"
                  required
                  maxLength={LADDER_NAME_MAX}
                  defaultValue={ladder.nameBg}
                  className="mt-1"
                />
              </label>
              <label className={field}>
                {t('form.nameEn')}
                <Input
                  name="nameEn"
                  maxLength={LADDER_NAME_MAX}
                  defaultValue={ladder.nameEn ?? ''}
                  className="mt-1"
                />
              </label>
            </div>
            <label className={field}>
              {t('form.sport')}
              <Select name="sport" defaultValue={ladder.sport ?? ''} className="mt-1">
                <option value="">{t('form.sportAll')}</option>
                {sports.map((sport) => (
                  <option key={sport.value} value={sport.value}>
                    {sport.label}
                  </option>
                ))}
              </Select>
              <span className={hint}>{t('form.sportHint')}</span>
            </label>
            <Button type="submit">{t('form.save')}</Button>
          </form>
          <form action={archiveLadderAction} className="mt-4">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="ladderId" value={ladder.id} />
            <input type="hidden" name="archive" value={ladder.archived ? '0' : '1'} />
            {ladder.archived ? (
              <Button type="submit" variant="secondary">
                {t('restore')}
              </Button>
            ) : (
              <ConfirmButton message={t('archiveConfirm')} className={quiet}>
                {t('archive')}
              </ConfirmButton>
            )}
          </form>
        </details>
      )}
    </main>
  );
}
