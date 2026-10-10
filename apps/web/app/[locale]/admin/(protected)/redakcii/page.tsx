import { CROWD_FEED_PAGE_SIZE, getDb, isRevertable, listCrowdEdits } from '@sportkarta/db';
import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { municipalityOptions } from '@/lib/admin-data';
import { describeEditValue, isMarkerEdit, type EditValueWords } from '@/lib/admin-edit-values';
import { requireRole } from '@/lib/auth-session';
import { isOnSite } from '@/lib/contributions/proximity';

import { revertAccountAction, revertEditAction } from './actions';
import { FEED_WINDOWS_HOURS, feedHref, parseFeedParams, REVERT_WINDOWS_HOURS } from './params';

export const metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * «Редакции» — what the crowd changed, newest first, with an undo
 * (pre-launch audit finding 53).
 *
 * Crowd edits outrank every import, so a vandal's change survives the next OSM
 * run; the operator's only remedy used to be finding and retyping each facility.
 * This lists every `source='crowd'` audit row with who made it and from how far
 * away, and offers "revert this edit" and "revert everything this account did
 * in the last N hours". A revert appends a compensating audit row with the
 * operator as actor (db/src/crowd-edits.ts) — the log itself is never touched.
 *
 * ADMIN-ONLY: reverting an account's edits is nationwide by nature, which is
 * not an ambassador's municipality-scoped authority.
 */

const OUTCOMES = ['reverted', 'superseded', 'already', 'not_revertable', 'not_found'] as const;

export default async function AdminCrowdEditsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const sp = await searchParams;
  const filters = parseFeedParams(sp);
  const [t, tAccess, tStatus, tSurface, tSport, tCondition, tEdit, activeLocale, rows] =
    await Promise.all([
      getTranslations('AdminCrowdEdits'),
      getTranslations('Access'),
      getTranslations('AdminStatus'),
      getTranslations('Surface'),
      getTranslations('Sport'),
      getTranslations('Condition'),
      getTranslations('AdminEdit'),
      getLocale(),
      listCrowdEdits(getDb(), {
        accountId: filters.akaunt,
        withinHours: filters.chasa ? Number(filters.chasa) : undefined,
        beforeId: filters.predi ? Number(filters.predi) : undefined,
      }),
    ]);

  const dateFmt = new Intl.DateTimeFormat(activeLocale, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Sofia',
  });
  const numberFmt = new Intl.NumberFormat(activeLocale, { maximumFractionDigits: 1 });

  // An operator's pin move records the municipalities it moved between, as ids.
  const municipalityNames = rows.some((row) => row.field === 'municipality_id')
    ? new Map((await municipalityOptions()).map((m) => [m.id, m.nameBg]))
    : null;

  const label = (translate: typeof tAccess, value: string): string =>
    translate.has(value) ? translate(value) : value;
  /** One side of an edit, in words rather than JSON (lib/admin-edit-values.ts). */
  const words: EditValueWords = {
    none: t('valueNone'),
    yes: t('valueYes'),
    no: t('valueNo'),
    access: (value) => label(tAccess, value),
    status: (value) => label(tStatus, value),
    surface: (value) => label(tSurface, value),
    condition: (value) => label(tCondition, value),
    sport: (value) => label(tSport, value),
    municipality: (value) => municipalityNames?.get(value),
  };
  const show = (field: string, value: unknown): string => describeEditValue(field, value, words);
  const fieldLabel = (field: string): string =>
    t.has(`field.${field}`) ? t(`field.${field}`) : field;
  const distance = (metres: number | null): string =>
    metres === null
      ? t('distanceNone')
      : metres >= 1000
        ? t('distanceKm', { km: numberFmt.format(metres / 1000) })
        : t('distanceM', { m: metres });

  const rezultat = typeof sp.rezultat === 'string' ? sp.rezultat : null;
  const lastRow = rows.at(-1);
  const hasMore = rows.length === CROWD_FEED_PAGE_SIZE && lastRow !== undefined;

  const pill = (active: boolean): string =>
    active
      ? 'inline-flex min-h-9 items-center rounded-pill bg-brand px-3 text-caption font-semibold text-on-brand'
      : 'inline-flex min-h-9 items-center rounded-pill border border-line-strong bg-surface px-3 text-caption font-medium text-ink-soft hover:bg-surface-2';

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      {rezultat === 'bulk' ? (
        <p className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-body-sm text-success">
          {t('bulkResult', {
            reverted: Number(sp.n ?? 0),
            superseded: Number(sp.s ?? 0),
            skipped: Number(sp.a ?? 0),
          })}
          {sp.t === '1' && <> {t('bulkTruncated')}</>}
        </p>
      ) : rezultat && (OUTCOMES as readonly string[]).includes(rezultat) ? (
        <p
          className={`rounded-md border px-3 py-2 text-body-sm ${rezultat === 'reverted' ? 'border-success-border bg-success-bg text-success' : 'border-warning-border bg-warning-bg text-warning'}`}
        >
          {t(`outcome.${rezultat}`)}
        </p>
      ) : null}

      <form className="flex flex-wrap items-end gap-2" action="/admin/redakcii">
        <label className="space-y-1.5">
          <span className="text-caption font-medium text-ink-soft">{t('accountLabel')}</span>
          <Input
            name="akaunt"
            defaultValue={filters.akaunt ?? ''}
            placeholder={t('accountPlaceholder')}
            className="w-72 max-w-full"
          />
        </label>
        {filters.chasa && <input type="hidden" name="chasa" value={filters.chasa} />}
        <Button type="submit" variant="secondary">
          {t('filter')}
        </Button>
        {filters.akaunt && (
          <Link
            href={feedHref({ ...filters, akaunt: undefined })}
            className="text-body-sm font-medium text-link hover:text-link-hover"
          >
            {t('clearAccount')}
          </Link>
        )}
      </form>

      <nav className="flex flex-wrap gap-2" aria-label={t('windowLabel')}>
        <Link href={feedHref({ ...filters, chasa: undefined })} className={pill(!filters.chasa)}>
          {t('windowAll')}
        </Link>
        {FEED_WINDOWS_HOURS.map((hours) => (
          <Link
            key={hours}
            href={feedHref({ ...filters, chasa: String(hours) })}
            className={pill(filters.chasa === String(hours))}
          >
            {t(`window.h${String(hours)}`)}
          </Link>
        ))}
      </nav>

      {filters.akaunt && (
        <section
          aria-labelledby="bulk-h"
          className="rounded-card border border-danger-border bg-surface p-4 shadow-sm"
        >
          <h2 id="bulk-h" className="text-h4 font-bold text-ink">
            {t('bulkTitle')}
          </h2>
          <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{t('bulkIntro')}</p>
          <form
            action={revertAccountAction.bind(null, filters)}
            className="mt-3 flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="akaunt" value={filters.akaunt} />
            <label className="space-y-1.5">
              <span className="text-caption font-medium text-ink-soft">{t('bulkWindow')}</span>
              <Select name="chasa" defaultValue={filters.chasa ?? '24'}>
                {REVERT_WINDOWS_HOURS.map((hours) => (
                  <option key={hours} value={hours}>
                    {t(`window.h${String(hours)}`)}
                  </option>
                ))}
              </Select>
            </label>
            <ConfirmButton
              message={t('bulkConfirm')}
              className="inline-flex min-h-11 items-center rounded-pill bg-danger px-4 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-[color-mix(in_oklab,var(--danger),black_12%)]"
            >
              {t('bulkSubmit')}
            </ConfirmButton>
          </form>
        </section>
      )}

      {rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
          {t('empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const remote = !isOnSite(row.distanceM);
            const proposal = row.field === 'access_proposed';
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-start gap-3 rounded-card border border-line bg-surface p-3 text-body-sm shadow-sm"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/facilities/${row.facilityId}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {row.facilityName ?? t('unnamed')}
                    </Link>
                    {row.facilityStatus === 'gone' && (
                      <Badge tone="neutral">{label(tStatus, 'gone')}</Badge>
                    )}
                    {proposal && <Badge tone="warning">{t('proposal')}</Badge>}
                    {row.field === 'condition' && remote && (
                      <Badge tone="warning">{t('remoteCondition')}</Badge>
                    )}
                  </div>
                  <div>
                    <span className="font-medium text-ink">{fieldLabel(row.field)}</span>
                    {!isMarkerEdit(row.field) && (
                      <>
                        : <span className="text-ink-soft">{show(row.field, row.oldValue)}</span> →{' '}
                        <span className="font-semibold text-ink">
                          {show(row.field, row.newValue)}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-caption text-text-muted">
                    <span className="font-mono tabular-nums">
                      {dateFmt.format(new Date(row.createdAt))}
                    </span>
                    <span>·</span>
                    <Link
                      href={feedHref({ ...filters, akaunt: row.actor, predi: undefined })}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {row.actorName ?? tEdit('formerUser')}
                    </Link>
                    {row.actorRole && row.actorRole !== 'user' && (
                      <Badge tone="info">{t(`role.${row.actorRole}`)}</Badge>
                    )}
                    <span>·</span>
                    <span className={remote ? 'font-semibold text-warning' : ''}>
                      {distance(row.distanceM)}
                    </span>
                  </div>
                </div>
                {isRevertable(row.field) && (
                  <form action={revertEditAction.bind(null, row.id, filters)}>
                    <ConfirmButton
                      message={t('revertConfirm')}
                      className="inline-flex min-h-9 items-center rounded-pill border border-line-strong bg-surface px-3 text-caption font-semibold text-ink-soft hover:bg-surface-2"
                    >
                      {row.field === 'created' ? t('revertCreated') : t('revert')}
                    </ConfirmButton>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && (
        <Link
          href={feedHref(filters, { predi: String(lastRow.id) })}
          className="inline-block text-body-sm font-medium text-link hover:text-link-hover"
        >
          {t('older')}
        </Link>
      )}
    </main>
  );
}
