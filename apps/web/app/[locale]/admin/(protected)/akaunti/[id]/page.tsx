import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { accountAccessHistory, recordAccountAccess } from '@/lib/account-access';
import { accountDetail } from '@/lib/account-admin';
import { requireRole } from '@/lib/auth-session';
import { cityDisplayName } from '@/lib/city-names';
import type { Role } from '@/lib/roles';
import { Link } from '@/i18n/navigation';

export const metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * One person's whole record (Stage 3, admin account management).
 *
 * ADMIN-ONLY — `requireRole('admin')`, not the panel-level `requireAdmin()`
 * which admits ambassadors. See the index page for why.
 *
 * THE ACCESS IS RECORDED BEFORE THE DATA IS READ. `recordAccountAccess` is
 * awaited above `accountDetail`, and it throws rather than swallowing a failure,
 * so a broken log means the panel does not render. That ordering is the whole
 * point: a log written after a successful read cannot describe a read that
 * crashed halfway, and a log that fails quietly would make "no rows" read as
 * "nobody looked".
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT SHOW, and why the absence is a feature:
 *  - session tokens, OAuth tokens, API key hashes, the calendar feed token, the
 *    digest unsubscribe token. Every one is a live bearer credential; rendering
 *    one turns a shoulder-glance or a screenshot into account takeover.
 *  - stored GPS geometry and heart-rate values. The training panel shows that a
 *    route or a health record EXISTS (`memberTrainings` returns existence
 *    booleans) and never the coordinates or the numbers. Heart rate is GDPR
 *    Art. 9 data on a separate lawful basis; "the admin can see everything" is
 *    not that basis, so reading the values needs an operator decision and a
 *    `health`-scoped access record, not a wider SELECT here.
 *  - an IP address, because none is stored anywhere (CHECK-enforced).
 *  - every consent control. Consent is the member's to give and withdraw; an
 *    admin toggle would also leave the underlying data behind, since withdrawal
 *    is what deletes it.
 */
export default async function AdminAccountPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const admin = await requireRole('admin');

  const [t, activeLocale] = await Promise.all([
    getTranslations('AdminAccounts'),
    getLocale(),
  ]);

  // Recorded first, and never inside a try/catch — see the header.
  await recordAccountAccess(admin.id, id, 'overview');

  const [detail, access] = await Promise.all([accountDetail(id), accountAccessHistory(id)]);
  if (!detail) notFound();

  const dateFmt = new Intl.DateTimeFormat(activeLocale, { dateStyle: 'medium' });
  const dateTimeFmt = new Intl.DateTimeFormat(activeLocale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Sofia',
  });
  const d = (value: string | null): string => (value ? dateFmt.format(new Date(value)) : t('none'));
  const dt = (value: string | null): string =>
    value ? dateTimeFmt.format(new Date(value)) : t('none');

  const roleLabel: Record<Role, string> = {
    user: t('roleUser'),
    ambassador: t('roleAmbassador'),
    admin: t('roleAdmin'),
  };
  const scopeLabel: Record<string, string> = {
    overview: t('scopeOverview'),
    training: t('scopeTraining'),
    health: t('scopeHealth'),
    export: t('scopeExport'),
  };

  const { identity, consent, authority, passport, play, comms, credentials } = detail;

  return (
    <main className="space-y-6">
      <div>
        <Link href="/admin/akaunti" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('back')}
        </Link>
        <h1 className="mt-2 text-h2 font-extrabold tracking-tight text-ink">
          {identity.displayName || t('noName')}
        </h1>
        <p className="mt-1 break-all font-mono text-body-sm text-ink-soft">{identity.email}</p>
      </div>

      <Panel title={t('identityTitle')}>
        <Facts
          rows={[
            [t('fieldEmailVerified'), identity.emailVerified ? t('yes') : t('no')],
            [t('fieldName'), identity.displayName || t('none')],
            [t('fieldCity'), identity.homeCity ?? t('none')],
            [t('fieldRole'), roleLabel[identity.role]],
            [t('fieldJoined'), d(identity.createdAt)],
            [t('fieldUpdated'), d(identity.updatedAt)],
            [t('fieldMinor'), identity.isMinor ? t('minorYes') : t('minorNo')],
          ]}
        />
        <Note>{t('noDobNote')}</Note>
      </Panel>

      <Panel title={t('consentTitle')}>
        <Note>{t('consentNote')}</Note>
        <Facts
          rows={[
            [t('consentPassport'), consent.isPublic ? t('yes') : t('no')],
            [t('consentActivity'), consent.showActivity ? t('yes') : t('no')],
            [t('consentHandle'), consent.hasHandle ? t('yes') : t('no')],
            [
              t('consentRouteAt'),
              consent.routeConsentAt
                ? t('consentGivenAt', { date: d(consent.routeConsentAt) })
                : t('consentNotRecorded'),
            ],
            [
              t('consentHealthAt'),
              consent.healthConsentAt
                ? t('consentGivenAt', { date: d(consent.healthConsentAt) })
                : t('consentNotRecorded'),
            ],
          ]}
        />
        <Note>{t('consentHandleNote')}</Note>
        <p className="rounded-md border border-warning-border bg-warning-bg p-3 text-caption text-warning">
          {t('art9Note')}
        </p>
      </Panel>

      {(identity.role !== 'user' || authority.scope.length > 0 || authority.grantsIssued > 0) && (
        <Panel title={t('authorityTitle')}>
          <p className="text-caption text-text-muted">{t('authorityScope')}</p>
          {authority.scope.length === 0 ? (
            <p className="text-body-sm text-warning">{t('authorityScopeEmpty')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {authority.scope.map((row) => (
                <li key={row.municipalityId}>
                  <Badge tone="brand">{cityDisplayName(row.nameBg, row.nameEn, activeLocale)}</Badge>
                </li>
              ))}
            </ul>
          )}
          <Facts
            rows={[
              [t('authorityDecisions'), String(detail.decisionsMade)],
              [t('authorityGrantsIssued'), String(authority.grantsIssued)],
            ]}
          />
        </Panel>
      )}

      <Panel title={t('passportTitle')}>
        <Note>{t('passportNote')}</Note>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label={t('statPoints')} value={passport.points} />
          <Stat label={t('statAdded')} value={passport.facilitiesAdded} />
          <Stat label={t('statVerified')} value={passport.facilitiesVerified} />
          <Stat label={t('statConditions')} value={passport.conditionsReported} />
          <Stat label={t('statCheckins')} value={passport.checkins} />
          <Stat label={t('statBadges')} value={passport.badges.length} />
        </dl>
        <Facts
          rows={[
            [
              t('streakDays'),
              t('streakCurrentLongest', {
                current: passport.streak.currentDays,
                longest: passport.streak.longestDays,
              }),
            ],
            [
              t('streakWeeks'),
              t('streakCurrentLongest', {
                current: passport.streak.currentWeeks,
                longest: passport.streak.longestWeeks,
              }),
            ],
          ]}
        />
      </Panel>

      <Panel title={t('ledgerTitle')}>
        <Note>{t('ledgerNote')}</Note>
        <Table
          head={[t('ledgerWhen'), t('ledgerEvent'), t('ledgerFacility'), t('ledgerPoints')]}
          rows={detail.ledger.map((row) => [
            dt(row.createdAt),
            row.event,
            row.facilityName ?? t('none'),
            String(row.points),
          ])}
          numericLast
          empty={t('none')}
        />
      </Panel>

      <Panel title={t('contributionsTitle')}>
        <Note>{t('contributionsNote')}</Note>
        <Facts
          rows={[
            [t('photosUploaded'), String(detail.photosUploaded)],
            [t('conditionReports'), String(detail.conditionReports)],
          ]}
        />
        <Table
          head={[
            t('ledgerWhen'),
            t('ledgerFacility'),
            t('contributionsField'),
            t('contributionsSource'),
          ]}
          rows={detail.contributions.map((row) => [
            dt(row.createdAt),
            row.facilityName ?? row.facilityId,
            row.field,
            row.source,
          ])}
          empty={t('none')}
        />
      </Panel>

      <Panel title={t('decisionsAboutTitle')}>
        <Note>{t('decisionsAboutNote')}</Note>
        {detail.decisionsAbout.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('decisionsAboutEmpty')}</p>
        ) : (
          <Table
            head={[t('ledgerWhen'), t('accessScope'), t('ledgerFacility'), t('ledgerEvent')]}
            rows={detail.decisionsAbout.map((row) => [
              dt(row.decidedAt),
              row.targetType,
              row.facilityName ?? t('none'),
              row.decision,
            ])}
            empty={t('none')}
          />
        )}
      </Panel>

      <Panel title={t('playTitle')}>
        <Facts
          rows={[
            [t('playSeries'), String(play.seriesOrganised)],
            [t('playRsvpActive'), String(play.rsvpsActive)],
            [t('playRsvpWithdrawn'), String(play.rsvpsWithdrawn)],
            [t('playVouched'), String(play.vouchedForOthers)],
            [t('playResultsRecorded'), String(play.resultsRecorded)],
            [t('playResultsAbout'), String(play.resultsAbout)],
            [
              t('playCheckinMethod'),
              play.checkins.length === 0
                ? t('none')
                : play.checkins.map((row) => `${row.method}: ${String(row.count)}`).join(' · '),
            ],
          ]}
        />
        <Note>{t('playSeriesNote')}</Note>
      </Panel>

      <Panel title={t('trainingTitle')}>
        <Note>{t('trainingNote')}</Note>
        {detail.trainings.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('trainingEmpty')}</p>
        ) : (
          <Table
            head={[
              t('trainingWhen'),
              t('trainingSport'),
              t('trainingDuration'),
              t('trainingDistance'),
              t('trainingPlace'),
              t('trainingHasRoute'),
              t('trainingHasMetrics'),
            ]}
            rows={detail.trainings.map((row) => [
              dateTimeFmt.format(row.startedAt),
              row.sport,
              t('unitMin', { v: Math.round(row.durationS / 60) }),
              row.distanceM === null ? t('none') : t('unitKm', { v: (row.distanceM / 1000).toFixed(1) }),
              row.facilityName ?? t('none'),
              row.hasRoute ? t('yes') : t('no'),
              row.hasMetrics ? t('yes') : t('no'),
            ])}
            empty={t('none')}
          />
        )}
      </Panel>

      <Panel title={t('commsTitle')}>
        <Note>{t('commsNote')}</Note>
        <Facts
          rows={[
            [
              t('commsDigestCities'),
              comms.digestCities.length === 0
                ? t('none')
                : comms.digestCities
                    .map((row) => cityDisplayName(row.nameBg, row.nameEn, activeLocale))
                    .join(' · '),
            ],
            [t('commsDigestSends'), `${String(comms.digestSends)} · ${d(comms.lastDigestAt)}`],
            [
              t('commsSessionMail'),
              `${String(comms.sessionMailCount)} · ${d(comms.lastSessionMailAt)}`,
            ],
          ]}
        />
      </Panel>

      <Panel title={t('credentialsTitle')}>
        <Note>{t('credentialsNote')}</Note>
        <Table
          head={[t('credentialsDevice'), t('columnJoined'), t('credentialsExpires')]}
          rows={credentials.sessions.map((row) => [
            row.userAgent ?? t('none'),
            d(row.createdAt),
            d(row.expiresAt),
          ])}
          empty={t('none')}
        />
        <Facts
          rows={[
            [
              t('credentialsProviders'),
              credentials.providers.length === 0
                ? t('none')
                : credentials.providers.map((row) => row.providerId).join(' · '),
            ],
            [
              t('credentialsApiKeys'),
              credentials.apiKeys.length === 0
                ? t('none')
                : credentials.apiKeys
                    .map(
                      (row) =>
                        `${row.label} (${row.prefix}) — ${row.revokedAt ? t('credentialsKeyRevoked') : t('credentialsKeyActive')}`,
                    )
                    .join(' · '),
            ],
            [
              t('credentialsCalendar'),
              credentials.calendar
                ? [
                    t('credentialsCalendarIssued', { date: d(credentials.calendar.issuedAt) }),
                    credentials.calendar.rotatedAt
                      ? t('credentialsCalendarRotated', { date: d(credentials.calendar.rotatedAt) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : t('credentialsCalendarNone'),
            ],
          ]}
        />
      </Panel>

      <Panel title={t('accessTitle')}>
        <Note>{t('accessNote')}</Note>
        {access.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('accessEmpty')}</p>
        ) : (
          <Table
            head={[t('accessWhen'), t('accessWho'), t('accessScope')]}
            rows={access.map((row) => [
              dt(row.viewedAt),
              row.actorDisplayName || row.actorEmail || t('formerUser'),
              scopeLabel[row.scope] ?? row.scope,
            ])}
            empty={t('none')}
          />
        )}
      </Panel>
    </main>
  );
}

/* ---------- presentational helpers (local; nothing here is reused elsewhere) ---------- */

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
      <h2 className="text-h4 font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-caption text-text-muted">{children}</p>;
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(12rem,auto)_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-body-sm text-text-muted">{label}</dt>
          <dd className="text-body-sm text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="font-mono text-h3 font-bold tabular-nums text-ink">{value}</dd>
      <dt className="text-caption text-text-muted">{label}</dt>
    </div>
  );
}

function Table({
  head,
  rows,
  empty,
  numericLast = false,
}: {
  head: string[];
  rows: string[][];
  empty: string;
  /** Right-align + mono the last column (points, counts). */
  numericLast?: boolean;
}) {
  if (rows.length === 0) return <p className="text-body-sm text-text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line text-left text-caption text-text-muted">
            {head.map((cell, i) => (
              <th
                key={cell}
                scope="col"
                className={`py-1.5 pr-3 font-medium ${
                  numericLast && i === head.length - 1 ? 'text-right' : ''
                }`}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // Index key: these are read-only projections that never reorder.
            <tr key={i} className="border-b border-line last:border-0">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`py-1.5 pr-3 ${
                    j === 0 ? 'font-mono text-caption text-text-muted whitespace-nowrap' : 'text-ink'
                  } ${numericLast && j === row.length - 1 ? 'text-right font-mono tabular-nums' : ''}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
