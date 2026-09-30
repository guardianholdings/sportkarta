import {
  createErrorReporter,
  reportFailures,
  type ErrorReporter,
} from '@sportkarta/lib/error-report';
import type PgBoss from 'pg-boss';

/**
 * Worker-side error reporting (pre-launch audit findings 57 and 90).
 *
 * Until now a failing job was visible in exactly two places: `docker logs`,
 * which the operator cannot reach, and pgboss.archive, which forgets after
 * seven days. The worker is also the ONLY sender of session mail, so a job
 * that fails every recipient still completes "successfully". This file sends
 * both kinds of trouble to GlitchTip when GLITCHTIP_DSN is set, and does
 * nothing at all when it is not.
 */
export const reporter: ErrorReporter = createErrorReporter({
  dsn: process.env.GLITCHTIP_DSN,
  component: 'worker',
  environment: process.env.NODE_ENV ?? 'development',
});

/**
 * `boss.work`, with every handler failure reported before pg-boss records it.
 * Same two call shapes as pg-boss's own; the queue name travels as a tag, and
 * the error is re-thrown so retries and the `failed` state are unchanged.
 */
export function reportingWork(boss: PgBoss) {
  function work<T>(name: string, handler: PgBoss.WorkHandler<T>): Promise<string>;
  function work<T>(
    name: string,
    options: PgBoss.WorkOptions,
    handler: PgBoss.WorkHandler<T>,
  ): Promise<string>;
  function work<T>(
    name: string,
    optionsOrHandler: PgBoss.WorkOptions | PgBoss.WorkHandler<T>,
    maybeHandler?: PgBoss.WorkHandler<T>,
  ): Promise<string> {
    if (typeof optionsOrHandler === 'function') {
      return boss.work<T>(
        name,
        reportFailures(reporter, { tags: { queue: name } }, optionsOrHandler),
      );
    }
    if (!maybeHandler) throw new Error(`work(${name}): handler is required`);
    return boss.work<T>(
      name,
      optionsOrHandler,
      reportFailures(reporter, { tags: { queue: name } }, maybeHandler),
    );
  }
  return work;
}

/**
 * A mail job that completed but could not deliver to somebody. Counts only —
 * the per-recipient reason is deliberately never kept (an SMTP rejection quotes
 * the address), so this says "how many, in which queue" and the operator's
 * health page says since when.
 */
export async function reportMailFailures(
  queue: string,
  report: { failed: number; sent: number },
): Promise<void> {
  if (report.failed <= 0) return;
  await reporter.captureMessage(`${queue}: ${String(report.failed)} mail(s) could not be sent`, {
    level: 'error',
    tags: { queue },
    extra: { failed: report.failed, sent: report.sent },
  });
}
