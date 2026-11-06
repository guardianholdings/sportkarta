import { getDb, mailBudgetToday, type MailBudgetKindToday } from '@sportkarta/db';
import { MAIL_BUDGET_WARN_AT, mailBudgetWarnAt } from '@sportkarta/lib/email';
import { parseDsn } from '@sportkarta/lib/error-report';
import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { enqueueFailures } from '@/lib/admin-boss';
import { requireRole } from '@/lib/auth-session';
import { describeCron, weekdayName } from '@/lib/cron-words';
import { mailBudgetLimits } from '@/lib/mail-budget';
import {
  HEARTBEAT_STALE_SECONDS,
  MAIL_WINDOW_DAYS,
  clubOpsHealth,
  mailOutcomes,
  queueHealth,
  queueKey,
  readWorkerHeartbeat,
  scheduleHealth,
  type WorkerStatus,
} from '@/lib/ops-health';

export const metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * «Здраве» — is the machinery running? (pre-launch audit findings 57 and 90)
 *
 * The operator has no SSH, so before this page a dead worker, a mail relay
 * refusing every reminder or a nightly job failing for a week were all
 * invisible until members complained. Everything shown is read from pg-boss's
 * own tables (lib/ops-health.ts) plus this web process's enqueue failures.
 *
 * ADMIN-ONLY (requireRole, not the panel's requireAdmin): it is operational,
 * not moderation, and it is municipality-agnostic. It shows counts, times and
 * scrubbed error messages — never a job's payload, which can name an account.
 *
 * On a phone the three tables are stacks of cards (globals.css
 * .sk-card-table, UX audit 2026-10-31 V-29): each row prints its column
 * names, and a cell with nothing to say — a zero, a «never» — is left out.
 */

const WORKER_TONE: Record<WorkerStatus, BadgeTone> = {
  ok: 'success',
  starting: 'info',
  stale: 'danger',
  unknown: 'warning',
};

/**
 * Where a mail budget share stands today (db/src/mail-budget.ts): the same
 * 80 % mark the worker and the web warn at once, and spent when the kind's
 * next send would be refused.
 */
type BudgetState = 'ok' | 'warning' | 'spent';

function budgetState(row: MailBudgetKindToday): BudgetState {
  if (row.sent >= row.limit) return 'spent';
  return row.sent >= mailBudgetWarnAt(row.limit) ? 'warning' : 'ok';
}

const BUDGET_TONE: Record<BudgetState, BadgeTone> = {
  ok: 'success',
  warning: 'warning',
  spent: 'danger',
};

/** The badge names the same mark the warning line fires at. */
const BUDGET_WARN_PERCENT = Math.round(MAIL_BUDGET_WARN_AT * 100);

export default async function AdminHealthPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const db = getDb();
  const [t, activeLocale, heartbeat, queues, schedules, mail, budget, clubs] = await Promise.all([
    getTranslations('AdminHealth'),
    getLocale(),
    readWorkerHeartbeat(db, process.uptime()),
    queueHealth(db),
    scheduleHealth(db),
    mailOutcomes(db),
    mailBudgetToday(db, mailBudgetLimits()),
    clubOpsHealth(db),
  ]);
  const enqueue = enqueueFailures();
  const serverReporting = parseDsn(process.env.GLITCHTIP_DSN) !== null;

  const dateFmt = new Intl.DateTimeFormat(activeLocale, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Sofia',
  });
  const when = (iso: string | null): string => (iso ? dateFmt.format(new Date(iso)) : t('never'));
  // A civil Sofia day (YYYY-MM-DD), shown as a date and never shifted by a zone.
  const dayFmt = new Intl.DateTimeFormat(activeLocale, { dateStyle: 'long', timeZone: 'UTC' });
  const budgetDay = budget.day ? dayFmt.format(new Date(`${budget.day}T00:00:00Z`)) : '—';
  const age = (seconds: number | null): string => {
    if (seconds === null) return '—';
    if (seconds < 90) return t('ageSeconds', { n: seconds });
    if (seconds < 90 * 60) return t('ageMinutes', { n: Math.round(seconds / 60) });
    if (seconds < 36 * 3600) return t('ageHours', { n: Math.round(seconds / 3600) });
    return t('ageDays', { n: Math.round(seconds / 86_400) });
  };
  const queueLabel = (name: string): string =>
    t.has(`queue.${queueKey(name)}`) ? t(`queue.${queueKey(name)}`) : name;
  // The schedule in words beside its cron (V-04): «на всеки 10 минути»,
  // «всяка седмица в понеделник в 08:00». A shape the parser does not know
  // prints the expression alone. A Sofia schedule says nothing more; the rest
  // run on UTC and say so.
  const cronWords = (cron: string, timezone: string | null): string | null => {
    const shape = describeCron(cron);
    if (!shape) return null;
    const words =
      shape.kind === 'everyMinute'
        ? t('cron.everyMinute')
        : shape.kind === 'everyMinutes'
          ? t('cron.everyMinutes', { n: shape.n })
          : shape.kind === 'hourly'
            ? t('cron.hourly', { minute: shape.minute })
            : shape.kind === 'daily'
              ? t('cron.daily', { time: shape.time })
              : shape.kind === 'weekly'
                ? t('cron.weekly', {
                    weekday: weekdayName(shape.weekday, activeLocale),
                    time: shape.time,
                  })
                : t('cron.monthly', { day: shape.day, time: shape.time });
    return timezone === 'Europe/Sofia' ? words : t('cron.inUtc', { words });
  };
  /** Marks a card cell with nothing to say, so the phone leaves it out. */
  const empty = (value: unknown) => (value ? undefined : '');

  const card = 'rounded-card border border-line bg-surface p-4 shadow-sm';
  const th = 't-overline py-2 pr-3 text-left';
  const rowHead = 'py-2 pr-3 text-left font-medium text-ink';
  const table = 'sk-card-table w-full border-collapse text-body-sm';

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      <section aria-labelledby="worker-h" className={card}>
        <h2 id="worker-h" className="t-overline mb-3">
          {t('workerTitle')}
        </h2>
        <div className="flex flex-wrap items-center gap-3 text-body-sm">
          <Badge tone={WORKER_TONE[heartbeat.status]}>{t(`worker.${heartbeat.status}`)}</Badge>
          <span className="text-ink-soft">
            {heartbeat.lastBeatAt
              ? t('workerLastBeat', {
                  when: when(heartbeat.lastBeatAt),
                  age: age(heartbeat.ageSeconds),
                })
              : t('workerNever')}
          </span>
        </div>
        <p className="mt-2 max-w-prose text-caption text-text-muted">
          {t('workerHelp', { minutes: HEARTBEAT_STALE_SECONDS / 60 })}
        </p>
        <dl className="mt-4 grid gap-3 text-body-sm sm:grid-cols-2">
          <div>
            <dt className="text-caption text-text-muted">{t('enqueueTitle')}</dt>
            <dd className={enqueue.count > 0 ? 'font-semibold text-danger' : 'text-ink'}>
              {enqueue.count === 0
                ? t('enqueueNone')
                : t('enqueueSome', { count: enqueue.count, when: when(enqueue.lastAt) })}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('reportingTitle')}</dt>
            <dd className={serverReporting ? 'text-ink' : 'font-semibold text-warning'}>
              {serverReporting ? t('reportingOn') : t('reportingOff')}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="mail-h" className={card}>
        <h2 id="mail-h" className="t-overline mb-3">
          {t('mailTitle', { days: MAIL_WINDOW_DAYS })}
        </h2>
        <div className="overflow-x-auto">
          <table className={table}>
            <thead>
              <tr className="border-b border-line-strong text-caption text-text-muted">
                <th scope="col" className={th}>
                  {t('colQueue')}
                </th>
                <th scope="col" className={th}>
                  {t('colSent')}
                </th>
                <th scope="col" className={th}>
                  {t('colMailFailed')}
                </th>
                <th scope="col" className={th}>
                  {t('colJobs')}
                </th>
                <th scope="col" className={th}>
                  {t('colJobsFailed')}
                </th>
              </tr>
            </thead>
            <tbody>
              {mail.map((row) => (
                <tr key={row.queue} className="border-b border-line">
                  <th scope="row" className={rowHead}>
                    {queueLabel(row.queue)}
                  </th>
                  {/* — for a queue whose jobs report no recipients (one
                      message each): its failed jobs are its failed mail. */}
                  <td
                    className="py-2 pr-3 tabular-nums"
                    data-label={t('colSent')}
                    data-empty={empty(row.sent)}
                  >
                    {row.sent ?? '—'}
                  </td>
                  <td
                    className={`py-2 pr-3 tabular-nums ${(row.failed ?? 0) > 0 ? 'font-semibold text-danger' : ''}`}
                    data-label={t('colMailFailed')}
                    data-empty={empty(row.failed)}
                  >
                    {row.failed ?? '—'}
                  </td>
                  <td
                    className="py-2 pr-3 tabular-nums"
                    data-label={t('colJobs')}
                    data-empty={empty(row.jobs)}
                  >
                    {row.jobs}
                  </td>
                  <td
                    className={`py-2 pr-3 tabular-nums ${row.failedJobs > 0 ? 'font-semibold text-danger' : ''}`}
                    data-label={t('colJobsFailed')}
                    data-empty={empty(row.failedJobs)}
                  >
                    {row.failedJobs}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 max-w-prose text-caption text-text-muted">{t('mailHelp')}</p>
      </section>

      <section aria-labelledby="budget-h" className={card}>
        <h2 id="budget-h" className="t-overline mb-3">
          {t('budgetTitle', { day: budgetDay })}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-line-strong text-caption text-text-muted">
                <th className={th}>{t('colKind')}</th>
                <th className={th}>{t('colBudgetSent')}</th>
                <th className={th}>{t('colBudgetShare')}</th>
                <th className={th}>{t('colBudgetRefused')}</th>
                <th className={th}>{t('colBudgetState')}</th>
              </tr>
            </thead>
            <tbody>
              {budget.kinds.map((row) => {
                const state = budgetState(row);
                return (
                  <tr key={row.kind} className="border-b border-line">
                    <td className="py-2 pr-3">{t(`budgetKind.${row.kind}`)}</td>
                    <td className="py-2 pr-3 tabular-nums">{row.sent}</td>
                    <td className="py-2 pr-3 tabular-nums">{row.limit}</td>
                    <td
                      className={`py-2 pr-3 tabular-nums ${row.refused > 0 ? 'font-semibold text-danger' : ''}`}
                    >
                      {row.refused}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={BUDGET_TONE[state]}>
                        {t(`budgetState.${state}`, { percent: BUDGET_WARN_PERCENT })}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 max-w-prose text-caption text-text-muted">
          {t('budgetHelp', { quota: budget.quota })}
        </p>
      </section>

      <section aria-labelledby="clubs-h" className={card}>
        <h2 id="clubs-h" className="t-overline mb-3">
          {t('clubsTitle')}
        </h2>
        <ul className="space-y-1 text-body-sm">
          {(
            [
              ['clubPendingEvents', clubs.pendingPaymentEvents, clubs.pendingPaymentEvents > 0],
              [
                'clubSubscriptionsAtStripe',
                clubs.subscriptionsLeftAtStripe30d,
                clubs.subscriptionsLeftAtStripe30d > 0,
              ],
              ['clubEndpointsDisabled', clubs.endpointsDisabled7d, clubs.endpointsDisabled7d > 0],
              ['clubBroadcastsWaiting', clubs.broadcastsWaiting, clubs.broadcastsWaiting > 0],
              ['clubSmsCapped', clubs.clubsAtSmsCap, clubs.clubsAtSmsCap > 0],
            ] as const
          ).map(([key, count, warn]) => (
            <li key={key} className={warn ? 'font-semibold text-danger' : ''}>
              {t(key, {
                count,
                age: key === 'clubPendingEvents' ? age(clubs.oldestPendingEventSeconds) : '',
              })}
            </li>
          ))}
        </ul>
        <p className="mt-2 max-w-prose text-caption text-text-muted">{t('clubsHelp')}</p>
      </section>

      <section aria-labelledby="queues-h" className={card}>
        <h2 id="queues-h" className="t-overline mb-3">
          {t('queuesTitle')}
        </h2>
        {queues.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('queuesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={table}>
              <thead>
                <tr className="border-b border-line-strong text-caption text-text-muted">
                  <th scope="col" className={th}>
                    {t('colQueue')}
                  </th>
                  <th scope="col" className={th}>
                    {t('colWaiting')}
                  </th>
                  <th scope="col" className={th}>
                    {t('colActive')}
                  </th>
                  <th scope="col" className={th}>
                    {t('colDone24h')}
                  </th>
                  <th scope="col" className={th}>
                    {t('colFailed24h')}
                  </th>
                  <th scope="col" className={th}>
                    {t('colLastDone')}
                  </th>
                  <th scope="col" className={th}>
                    {t('colLastFailed')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {queues.map((row) => (
                  <tr key={row.name} className="border-b border-line align-top">
                    <th scope="row" className={rowHead}>
                      <div>{queueLabel(row.name)}</div>
                      <code className="text-caption font-normal text-text-muted">{row.name}</code>
                    </th>
                    <td
                      className={`py-2 pr-3 tabular-nums ${row.due > 0 && (row.oldestDueSeconds ?? 0) > 15 * 60 ? 'font-semibold text-danger' : ''}`}
                      data-label={t('colWaiting')}
                      data-empty={empty(row.due)}
                    >
                      {row.due > 0
                        ? t('waiting', { count: row.due, age: age(row.oldestDueSeconds) })
                        : '0'}
                    </td>
                    <td
                      className="py-2 pr-3 tabular-nums"
                      data-label={t('colActive')}
                      data-empty={empty(row.active)}
                    >
                      {row.active}
                    </td>
                    <td
                      className="py-2 pr-3 tabular-nums"
                      data-label={t('colDone24h')}
                      data-empty={empty(row.completed24h)}
                    >
                      {row.completed24h}
                    </td>
                    <td
                      className={`py-2 pr-3 tabular-nums ${row.failed24h > 0 || row.retrying > 0 ? 'font-semibold text-danger' : ''}`}
                      data-label={t('colFailed24h')}
                      data-empty={empty(row.failed24h || row.retrying)}
                    >
                      {/* One child per cell: on a phone the cell is a flex row
                          of label and value (globals.css .sk-card-table). */}
                      <div>
                        {row.failed24h}
                        {row.retrying > 0 && (
                          <div className="text-caption font-normal">
                            {t('retrying', { count: row.retrying })}
                          </div>
                        )}
                      </div>
                    </td>
                    <td
                      className="py-2 pr-3 text-caption whitespace-nowrap"
                      data-label={t('colLastDone')}
                      data-empty={empty(row.lastCompletedAt)}
                    >
                      {when(row.lastCompletedAt)}
                    </td>
                    <td
                      className="py-2 pr-3 text-caption"
                      data-label={t('colLastFailed')}
                      data-empty={empty(row.lastFailedAt ?? row.lastError)}
                    >
                      <div>
                        <div className="whitespace-nowrap">{when(row.lastFailedAt)}</div>
                        {row.lastError && (
                          <div className="mt-1 max-w-xs break-words text-danger">
                            {row.lastError}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="schedules-h" className={card}>
        <h2 id="schedules-h" className="t-overline mb-3">
          {t('schedulesTitle')}
        </h2>
        <p className="mb-2 text-caption text-text-muted">
          {t('cronChecked', { when: when(schedules.cronCheckedAt) })}
        </p>
        {schedules.rows.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('schedulesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={table}>
              <thead>
                <tr className="border-b border-line-strong text-caption text-text-muted">
                  <th scope="col" className={th}>
                    {t('colQueue')}
                  </th>
                  <th scope="col" className={th}>
                    {t('colCron')}
                  </th>
                  <th scope="col" className={th}>
                    {t('colLastRun')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {schedules.rows.map((row) => {
                  const words = cronWords(row.cron, row.timezone);
                  return (
                    <tr key={row.name} className="border-b border-line align-top">
                      <th scope="row" className={rowHead}>
                        {queueLabel(row.name)}
                      </th>
                      <td className="py-2 pr-3" data-label={t('colCron')}>
                        <div>
                          {words && <div>{words}</div>}
                          <code className="text-caption text-text-muted">{row.cron}</code>
                          {row.timezone && (
                            <span className="text-caption text-text-muted"> · {row.timezone}</span>
                          )}
                        </div>
                      </td>
                      <td
                        className="py-2 pr-3 text-caption whitespace-nowrap"
                        data-label={t('colLastRun')}
                        data-empty={empty(row.lastRunAt)}
                      >
                        {when(row.lastRunAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
