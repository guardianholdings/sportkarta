import { getDb } from '@sportkarta/db';
import { parseDsn } from '@sportkarta/lib/error-report';
import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { enqueueFailures } from '@/lib/admin-boss';
import { requireRole } from '@/lib/auth-session';
import {
  HEARTBEAT_STALE_SECONDS,
  MAIL_WINDOW_DAYS,
  mailOutcomes,
  queueHealth,
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
 */

/** A queue name to its i18n key: `session.notify` → `sessionNotify`. */
function queueKey(name: string): string {
  return name.replace(/[._-](\w)/g, (_, c: string) => c.toUpperCase());
}

const WORKER_TONE: Record<WorkerStatus, BadgeTone> = {
  ok: 'success',
  starting: 'info',
  stale: 'danger',
  unknown: 'warning',
};

export default async function AdminHealthPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const db = getDb();
  const [t, activeLocale, heartbeat, queues, schedules, mail] = await Promise.all([
    getTranslations('AdminHealth'),
    getLocale(),
    readWorkerHeartbeat(db, process.uptime()),
    queueHealth(db),
    scheduleHealth(db),
    mailOutcomes(db),
  ]);
  const enqueue = enqueueFailures();
  const serverReporting = parseDsn(process.env.GLITCHTIP_DSN) !== null;

  const dateFmt = new Intl.DateTimeFormat(activeLocale, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Sofia',
  });
  const when = (iso: string | null): string => (iso ? dateFmt.format(new Date(iso)) : t('never'));
  const age = (seconds: number | null): string => {
    if (seconds === null) return '—';
    if (seconds < 90) return t('ageSeconds', { n: seconds });
    if (seconds < 90 * 60) return t('ageMinutes', { n: Math.round(seconds / 60) });
    if (seconds < 36 * 3600) return t('ageHours', { n: Math.round(seconds / 3600) });
    return t('ageDays', { n: Math.round(seconds / 86_400) });
  };
  const queueLabel = (name: string): string =>
    t.has(`queue.${queueKey(name)}`) ? t(`queue.${queueKey(name)}`) : name;

  const card = 'rounded-card border border-line bg-surface p-4 shadow-sm';
  const th = 't-overline py-2 pr-3 text-left';

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
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-line-strong text-caption text-text-muted">
                <th className={th}>{t('colQueue')}</th>
                <th className={th}>{t('colSent')}</th>
                <th className={th}>{t('colMailFailed')}</th>
                <th className={th}>{t('colJobs')}</th>
                <th className={th}>{t('colJobsFailed')}</th>
              </tr>
            </thead>
            <tbody>
              {mail.map((row) => (
                <tr key={row.queue} className="border-b border-line">
                  <td className="py-2 pr-3">{queueLabel(row.queue)}</td>
                  {/* — for a queue whose jobs report no recipients (one
                      message each): its failed jobs are its failed mail. */}
                  <td className="py-2 pr-3 tabular-nums">{row.sent ?? '—'}</td>
                  <td
                    className={`py-2 pr-3 tabular-nums ${(row.failed ?? 0) > 0 ? 'font-semibold text-danger' : ''}`}
                  >
                    {row.failed ?? '—'}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{row.jobs}</td>
                  <td
                    className={`py-2 pr-3 tabular-nums ${row.failedJobs > 0 ? 'font-semibold text-danger' : ''}`}
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

      <section aria-labelledby="queues-h" className={card}>
        <h2 id="queues-h" className="t-overline mb-3">
          {t('queuesTitle')}
        </h2>
        {queues.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('queuesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="border-b border-line-strong text-caption text-text-muted">
                  <th className={th}>{t('colQueue')}</th>
                  <th className={th}>{t('colWaiting')}</th>
                  <th className={th}>{t('colActive')}</th>
                  <th className={th}>{t('colDone24h')}</th>
                  <th className={th}>{t('colFailed24h')}</th>
                  <th className={th}>{t('colLastDone')}</th>
                  <th className={th}>{t('colLastFailed')}</th>
                </tr>
              </thead>
              <tbody>
                {queues.map((row) => (
                  <tr key={row.name} className="border-b border-line align-top">
                    <td className="py-2 pr-3">
                      <div>{queueLabel(row.name)}</div>
                      <code className="text-caption text-text-muted">{row.name}</code>
                    </td>
                    <td
                      className={`py-2 pr-3 tabular-nums ${row.due > 0 && (row.oldestDueSeconds ?? 0) > 15 * 60 ? 'font-semibold text-danger' : ''}`}
                    >
                      {row.due > 0
                        ? t('waiting', { count: row.due, age: age(row.oldestDueSeconds) })
                        : '0'}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{row.active}</td>
                    <td className="py-2 pr-3 tabular-nums">{row.completed24h}</td>
                    <td
                      className={`py-2 pr-3 tabular-nums ${row.failed24h > 0 || row.retrying > 0 ? 'font-semibold text-danger' : ''}`}
                    >
                      {row.failed24h}
                      {row.retrying > 0 && (
                        <div className="text-caption font-normal">
                          {t('retrying', { count: row.retrying })}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-caption whitespace-nowrap">
                      {when(row.lastCompletedAt)}
                    </td>
                    <td className="py-2 pr-3 text-caption">
                      <div className="whitespace-nowrap">{when(row.lastFailedAt)}</div>
                      {row.lastError && (
                        <div className="mt-1 max-w-xs break-words text-danger">{row.lastError}</div>
                      )}
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
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="border-b border-line-strong text-caption text-text-muted">
                  <th className={th}>{t('colQueue')}</th>
                  <th className={th}>{t('colCron')}</th>
                  <th className={th}>{t('colLastRun')}</th>
                </tr>
              </thead>
              <tbody>
                {schedules.rows.map((row) => (
                  <tr key={row.name} className="border-b border-line">
                    <td className="py-2 pr-3">{queueLabel(row.name)}</td>
                    <td className="py-2 pr-3">
                      <code className="text-caption">{row.cron}</code>
                      {row.timezone && (
                        <span className="text-caption text-text-muted"> · {row.timezone}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-caption whitespace-nowrap">
                      {when(row.lastRunAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
