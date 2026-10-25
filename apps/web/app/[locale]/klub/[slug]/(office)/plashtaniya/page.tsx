import {
  CLUB_PAYMENT_METHODS,
  euroInputValue,
  formatEuro,
  sofiaToday,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { ChargeForm, PaymentForm } from '@/components/clubs/payment-forms';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { memberChoices } from '@/lib/clubs/members';
import { unappliedCheckouts } from '@/lib/clubs/payments';
import { refundsDue } from '@/lib/clubs/reservations';
import { openCharges, paymentLedger } from '@/lib/clubs/sales';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

import { ConfirmButton } from '@/components/ui/confirm-button';

import {
  createChargeAction,
  recordPaymentAction,
  refundOnlineAction,
  refundReservationAction,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function ClubPaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{
    mesec?: string;
    nachin?: string;
    zadalzhenie?: string;
    chlen?: string;
    rezultat?: string;
  }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'payments.view');
  const query = await searchParams;
  const today = sofiaToday();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.mesec ?? '')
    ? (query.mesec as string)
    : today.slice(0, 7);
  const method = (CLUB_PAYMENT_METHODS as readonly string[]).includes(query.nachin ?? '')
    ? (query.nachin as string)
    : null;
  const memberFilter = isUuid(query.chlen) ? query.chlen : undefined;
  const canRecord = actorCan(actor, 'payments.record');
  const [t, tClub, messages, ledger, open, members, unapplied, owed] = await Promise.all([
    getTranslations('ClubSales.payments'),
    getTranslations('Club'),
    clubFormMessages(),
    paymentLedger(actor, month, method),
    openCharges(actor, { memberId: memberFilter }),
    canRecord ? memberChoices(actor) : Promise.resolve([]),
    unappliedCheckouts(actor),
    refundsDue(actor),
  ]);
  const outcome = query.rezultat && t.has(`outcome.${query.rezultat}`) ? query.rezultat : null;
  const methods: Record<string, string> = {
    ...Object.fromEntries(CLUB_PAYMENT_METHODS.map((m) => [m, tClub(`method.${m}`)])),
    card_online: tClub('method.card_online'),
  };
  const canRefund = actorCan(actor, 'charges.void');
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';

  return (
    <main className="space-y-5">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      <div role="status" aria-live="polite">
        {outcome && (
          <p
            className={cn(
              'rounded-card border p-3 text-body-sm text-ink',
              outcome === 'refunded'
                ? 'border-success-border bg-success-bg'
                : 'border-warning-border bg-warning-bg',
            )}
          >
            {t(`outcome.${outcome}`)}
          </p>
        )}
      </div>

      {unapplied.length > 0 && (
        <section
          className="space-y-2 rounded-card border border-warning-border bg-warning-bg p-4"
          aria-labelledby="unapplied-h"
        >
          <h2 id="unapplied-h" className="text-h4 font-bold text-ink">
            {t('unappliedTitle')}
          </h2>
          <p className="max-w-prose text-body-sm text-ink">{t('unappliedHint')}</p>
          <ul className="divide-y divide-line">
            {unapplied.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-mono tabular-nums text-ink">
                  {formatEuro(row.amountCents, locale)}
                </span>
                <span className="text-body-sm text-ink">
                  {row.memberId && row.memberName ? (
                    <Link href={`/klub/${slug}/chlenove/${row.memberId}`} className="text-link">
                      {row.memberName}
                    </Link>
                  ) : (
                    '—'
                  )}
                </span>
                <span className="text-caption text-text-muted">
                  {formatDateTime(row.completedAt, locale)}
                </span>
                {row.provider === 'stripe' && (
                  <a
                    href={`https://dashboard.stripe.com/payments/${encodeURIComponent(row.paymentRef)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-caption font-semibold text-link hover:text-link-hover"
                  >
                    {t('openInStripe')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {owed.length > 0 && (
        <section
          className="space-y-2 rounded-card border border-warning-border bg-warning-bg p-4"
          aria-labelledby="refunds-due-h"
        >
          <h2 id="refunds-due-h" className="text-h4 font-bold text-ink">
            {t('refundsDueTitle')}
          </h2>
          <p className="max-w-prose text-body-sm text-ink">{t('refundsDueHint')}</p>
          <ul className="divide-y divide-line">
            {owed.map((row) => (
              <li
                key={row.reservationId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
              >
                <span className="font-mono tabular-nums text-ink">
                  {formatEuro(row.paidCents, locale)}
                </span>
                <span className="text-body-sm text-ink">
                  {row.memberId && row.memberName ? (
                    <Link href={`/klub/${slug}/chlenove/${row.memberId}`} className="text-link">
                      {row.memberName}
                    </Link>
                  ) : (
                    '—'
                  )}
                </span>
                <span className="text-caption text-text-muted">
                  {row.serviceName} · {formatDateTime(row.startsAt, locale)}
                </span>
                {row.online ? (
                  <span className="text-caption text-ink">{t('refundOnlineHint')}</span>
                ) : (
                  canRecord && (
                    <form action={refundReservationAction} className="flex items-center gap-1">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="reservationId" value={row.reservationId} />
                      <Select name="method" size="sm" aria-label={t('refundMethod')}>
                        {CLUB_PAYMENT_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {methods[m]}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit" variant="secondary" size="sm">
                        {t('recordRefund')}
                      </Button>
                    </form>
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canRecord && (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className={section}>
            <h2 className="text-h4 font-bold text-ink">{t('record')}</h2>
            <PaymentForm
              action={recordPaymentAction}
              slug={slug}
              messages={{ ...messages, saved: t('recorded') }}
              today={today}
              defaultChargeId={
                isUuid(query.zadalzhenie)
                  ? query.zadalzhenie
                  : open.length === 1
                    ? (open[0]?.id ?? null)
                    : null
              }
              charges={open.map((charge) => ({
                id: charge.id,
                label: `${charge.memberName ?? '—'} · ${charge.label} · ${t('due', {
                  amount: formatEuro(charge.dueCents, locale),
                  date: formatDate(charge.dueOn, locale),
                })}`,
                due: euroInputValue(charge.dueCents, locale),
              }))}
              labels={{
                charge: t('charge'),
                chargePick: t('chargePick'),
                kind: t('kind'),
                payment: t('payment'),
                refund: t('refund'),
                method: t('col.method'),
                methods,
                amount: t('chargeAmount'),
                receivedOn: t('col.date'),
                submit: t('submit'),
              }}
            />
          </section>
          <section className={section}>
            <h2 className="text-h4 font-bold text-ink">{t('newCharge')}</h2>
            <ChargeForm
              action={createChargeAction}
              slug={slug}
              messages={messages}
              today={today}
              defaultMemberId={memberFilter ?? null}
              members={members.map((m) => ({ id: m.id, label: m.displayName }))}
              labels={{
                member: t('chargeMember'),
                memberPick: t('chargePick'),
                label: t('chargeLabel'),
                amount: t('chargeAmount'),
                due: t('chargeDue'),
                submit: t('chargeSubmit'),
              }}
            />
          </section>
        </div>
      )}

      <section className={section}>
        <h2 className="text-h4 font-bold text-ink">{t('openTitle')}</h2>
        {open.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('noOpen')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {open.map((charge) => (
              <li
                key={charge.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-body-sm"
              >
                <span>
                  {charge.memberId ? (
                    <Link
                      href={`/klub/${slug}/chlenove/${charge.memberId}`}
                      className="font-medium text-link"
                    >
                      {charge.memberName}
                    </Link>
                  ) : (
                    <span className="font-medium text-ink">—</span>
                  )}
                  <span className="block text-caption text-text-muted">{charge.label}</span>
                </span>
                <span
                  className={charge.status === 'overdue' ? 'font-semibold text-danger' : 'text-ink'}
                >
                  {t('due', {
                    amount: formatEuro(charge.dueCents, locale),
                    date: formatDate(charge.dueOn, locale),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={section}>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-caption text-ink-soft">
            {t('month')}
            <Input type="month" name="mesec" defaultValue={month} size="sm" />
          </label>
          <label className="text-caption text-ink-soft">
            {t('col.method')}
            <Select name="nachin" defaultValue={method ?? ''} size="sm">
              <option value="">{t('allMethods')}</option>
              {CLUB_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {methods[m]}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="secondary" size="sm">
            {t('show')}
          </Button>
          <a
            href={`/api/clubs/${slug}/eksport/payments.csv`}
            className="ml-auto text-body-sm font-semibold text-link"
            download
          >
            {t('csv')}
          </a>
        </form>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <div>
            <dt className="text-caption text-text-muted">{t('total')}</dt>
            <dd className="font-mono text-h3 font-semibold tabular-nums text-ink">
              {formatEuro(ledger.totalCents, locale)}
            </dd>
          </div>
          {Object.entries(ledger.byMethod).map(([m, cents]) => (
            <div key={m}>
              <dt className="text-caption text-text-muted">{methods[m] ?? m}</dt>
              <dd className="font-mono text-h4 tabular-nums text-ink">
                {formatEuro(cents, locale)}
              </dd>
            </div>
          ))}
        </dl>
        {ledger.rows.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-body-sm">
              <thead>
                <tr className="border-b border-line text-left text-caption text-text-muted">
                  {(['date', 'member', 'for', 'method', 'amount', 'by', 'action'] as const).map(
                    (col) => (
                      <th
                        key={col}
                        scope="col"
                        className={`py-1.5 pr-3 font-medium ${col === 'amount' ? 'text-right' : ''}`}
                      >
                        {t(`col.${col}`)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {ledger.rows.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-0">
                    <td className="whitespace-nowrap py-1.5 pr-3">
                      {formatDate(row.receivedOn, locale)}
                    </td>
                    <td className="py-1.5 pr-3">
                      {row.memberId ? (
                        <Link href={`/klub/${slug}/chlenove/${row.memberId}`} className="text-link">
                          {row.memberName}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      {row.chargeLabel}
                      {row.kind === 'refund' ? ` (${t('refund')})` : ''}
                    </td>
                    <td className="py-1.5 pr-3">{methods[row.method] ?? row.method}</td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {formatEuro(row.amountCents, locale)}
                    </td>
                    <td className="py-1.5 pr-3 text-text-muted">
                      {row.recordedBy ?? (row.method === 'card_online' ? t('online') : '—')}
                    </td>
                    <td className="py-1.5 pr-3">
                      {canRefund && row.method === 'card_online' && row.kind === 'payment' && (
                        <form action={refundOnlineAction} className="flex items-center gap-1">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="paymentId" value={row.id} />
                          <Input
                            name="amount"
                            size="sm"
                            inputMode="decimal"
                            placeholder={t('refundAll')}
                            aria-label={t('refundAmount')}
                            className="w-24"
                          />
                          <ConfirmButton
                            message={t('refundConfirm')}
                            className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
                          >
                            {t('refundOnline')}
                          </ConfirmButton>
                        </form>
                      )}
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
