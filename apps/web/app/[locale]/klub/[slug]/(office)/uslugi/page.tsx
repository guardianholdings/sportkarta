import { CLUB_PLAN_AUDIENCES, euroInputValue, formatEuro } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { clubTakesPayments } from '@/lib/clubs/payments';
import {
  CLUB_SERVICE_KINDS,
  CLUB_SERVICE_PAYMENTS,
  MAX_BOOKING_WINDOW_DAYS,
} from '@/lib/clubs/input';
import { clubResources } from '@/lib/clubs/resources';
import { clubServices, priceRules, staffHours, type ClubService } from '@/lib/clubs/services';
import { clubLocations } from '@/lib/clubs/settings';
import { clubTeam } from '@/lib/clubs/staff';
import { formErrorText, isPlainCode } from '@/lib/clubs/form-error';

import {
  addPriceRuleAction,
  archiveServiceAction,
  removePriceRuleAction,
  saveServiceAction,
  saveStaffHoursAction,
} from './actions';

export const dynamic = 'force-dynamic';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

/**
 * What members book (0048, wave C): court and room rentals by the hour, and
 * appointments with a trainer — durations, buffer, price and its peak /
 * off-peak rules, payment, and which courts and trainers each may use; and
 * when each trainer takes appointments.
 */
export default async function ClubServicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const [t, tClub, messages, locations, resources, services, rules, team, hours, online] =
    await Promise.all([
      getTranslations('ClubServices'),
      getTranslations('Club'),
      clubFormMessages(),
      clubLocations(actor),
      clubResources(actor),
      clubServices(actor, { includeArchived: true }),
      priceRules(actor),
      clubTeam(actor),
      staffHours(actor),
      clubTakesPayments(actor.clubId),
    ]);
  const { rezultat } = await searchParams;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const small = 'text-caption text-ink-soft';
  const staff = team.staff;

  const serviceFields = (service: ClubService | null) => (
    <>
      <input type="hidden" name="slug" value={slug} />
      {service && <input type="hidden" name="serviceId" value={service.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          {t('kind')}
          <Select name="kind" defaultValue={service?.kind ?? 'rental'} className="mt-1">
            {CLUB_SERVICE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kinds.${kind}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className={field}>
          {t('location')}
          <Select
            name="locationId"
            defaultValue={service?.locationId ?? locations[0]?.id}
            className="mt-1"
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <label className={field}>
        {t('nameBg')}
        <Input
          name="nameBg"
          required
          maxLength={80}
          defaultValue={service?.nameBg ?? ''}
          className="mt-1"
        />
      </label>
      <label className={field}>
        {t('nameEn')}
        <Input name="nameEn" maxLength={80} defaultValue={service?.nameEn ?? ''} className="mt-1" />
      </label>
      <label className={field}>
        {t('description')}
        <Textarea
          name="descriptionBg"
          maxLength={500}
          rows={2}
          defaultValue={service?.descriptionBg ?? ''}
          className="mt-1"
        />
      </label>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-1 text-body-sm font-semibold text-ink">{t('length')}</legend>
        <label className={small}>
          {t('durationMin')}
          <Input
            name="durationMin"
            type="number"
            min={15}
            max={720}
            required
            defaultValue={service?.durationMin ?? 60}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('durationMax')}
          <Input
            name="durationMax"
            type="number"
            min={15}
            max={720}
            defaultValue={service?.durationMax ?? 60}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('step')}
          <Input
            name="stepMinutes"
            type="number"
            min={5}
            max={240}
            defaultValue={service?.stepMinutes ?? 30}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('buffer')}
          <Input
            name="bufferMinutes"
            type="number"
            min={0}
            max={120}
            defaultValue={service?.bufferMinutes ?? 0}
            className="mt-1"
          />
        </label>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-body-sm font-semibold text-ink">{t('priceTitle')}</legend>
        <label className={small}>
          {t('price')}
          <Input
            name="price"
            inputMode="decimal"
            required
            defaultValue={service ? euroInputValue(service.priceCents, locale) : ''}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('priceUnit')}
          <Select name="priceUnit" defaultValue={service?.priceUnit ?? 'hour'} className="mt-1">
            <option value="hour">{t('perHour')}</option>
            <option value="booking">{t('perBooking')}</option>
          </Select>
        </label>
        <label className={small}>
          {t('memberPrice')}
          <Input
            name="memberPrice"
            inputMode="decimal"
            defaultValue={
              service?.memberPriceCents != null
                ? euroInputValue(service.memberPriceCents, locale)
                : ''
            }
            className="mt-1"
          />
        </label>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={small}>
          {t('window', { max: MAX_BOOKING_WINDOW_DAYS })}
          <Input
            name="windowDays"
            type="number"
            min={1}
            max={MAX_BOOKING_WINDOW_DAYS}
            defaultValue={service?.bookingWindowDays ?? 14}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('cancelHours')}
          <Input
            name="cancelHours"
            type="number"
            min={0}
            max={168}
            defaultValue={service?.cancelDeadlineHours ?? 24}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('payment')}
          <Select name="payment" defaultValue={service?.payment ?? 'desk'} className="mt-1">
            {CLUB_SERVICE_PAYMENTS.map((p) => (
              <option key={p} value={p}>
                {t(`payments.${p}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className={small}>
          {t('maxUpcoming')}
          <Input
            name="maxUpcoming"
            type="number"
            min={1}
            max={50}
            defaultValue={service?.maxUpcomingPerMember ?? 4}
            className="mt-1"
          />
        </label>
      </div>
      {!online && <p className="text-caption text-text-muted">{t('onlineNeedsAccount')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={small}>
          {t('audience')}
          <Select name="audience" defaultValue={service?.audience ?? 'all'} className="mt-1">
            {CLUB_PLAN_AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {tClub(`audience.${a}`)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-body-sm text-ink">
          <input
            type="checkbox"
            name="public"
            defaultChecked={service ? service.visibility === 'public' : true}
            className="size-4 accent-[var(--brand)]"
          />
          {t('public')}
        </label>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-body-sm font-semibold text-ink">{t('resources')}</legend>
        {resources.length === 0 && (
          <p className="text-caption text-text-muted">{t('noResources')}</p>
        )}
        <div className="flex flex-wrap gap-x-4">
          {resources.map((r) => (
            <label key={r.id} className="flex min-h-11 items-center gap-2 text-body-sm text-ink">
              <input
                type="checkbox"
                name="resourceIds"
                value={r.id}
                defaultChecked={service?.resourceIds.includes(r.id) ?? false}
                className="size-4 accent-[var(--brand)]"
              />
              {r.name}
              <span className="text-caption text-text-muted">{r.locationName}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-body-sm font-semibold text-ink">{t('trainers')}</legend>
        <div className="flex flex-wrap gap-x-4">
          {staff.map((s) => (
            <label
              key={s.userId}
              className="flex min-h-11 items-center gap-2 text-body-sm text-ink"
            >
              <input
                type="checkbox"
                name="staffUserIds"
                value={s.userId}
                defaultChecked={service?.staffUserIds.includes(s.userId) ?? false}
                className="size-4 accent-[var(--brand)]"
              />
              {s.name}
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      {rezultat && rezultat !== 'saved' && (
        <p
          role="status"
          className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
        >
          {isPlainCode(rezultat) && t.has(`error.${rezultat}`)
            ? t(`error.${rezultat}`)
            : formErrorText(messages, rezultat)}
        </p>
      )}

      {locations.length === 0 ? (
        <p className="text-body-sm text-text-muted">{t('needLocation')}</p>
      ) : (
        <>
          <section className={section} aria-labelledby="svc-h">
            <h2 id="svc-h" className="text-h4 font-bold text-ink">
              {t('listTitle')}
            </h2>
            {services.length === 0 && <p className="text-body-sm text-text-muted">{t('empty')}</p>}
            <ul className="divide-y divide-line">
              {services.map((service) => {
                const own = rules.filter((r) => r.serviceId === service.id);
                return (
                  <li key={service.id} id={`s-${service.id}`} className="py-2">
                    <details>
                      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-body-sm">
                        <span className="font-semibold text-ink">{service.nameBg}</span>
                        <span className="text-caption text-text-muted">
                          {t(`kinds.${service.kind}`)} · {formatEuro(service.priceCents, locale)}{' '}
                          {service.priceUnit === 'hour' ? t('perHour') : t('perBooking')}
                          {service.archived ? ` · ${t('archived')}` : ''}
                        </span>
                      </summary>
                      <form action={saveServiceAction} className="mt-2 space-y-3">
                        {serviceFields(service)}
                        <Button type="submit" size="sm">
                          {t('save')}
                        </Button>
                      </form>
                      <div className="mt-3 space-y-2 border-t border-line pt-3">
                        <h3 className="text-body-sm font-bold text-ink">{t('rulesTitle')}</h3>
                        <p className="text-caption text-text-muted">{t('rulesHint')}</p>
                        {own.length > 0 && (
                          <ul className="space-y-1">
                            {own.map((rule) => (
                              <li
                                key={rule.id}
                                className="flex flex-wrap items-center gap-2 text-body-sm"
                              >
                                <span className="min-w-0 flex-1 text-ink">
                                  {rule.weekdays
                                    .map((d) => tClub(`weekday.${WEEKDAYS[d - 1] ?? 'MO'}`))
                                    .join(', ')}{' '}
                                  {rule.from}–{rule.to} · {formatEuro(rule.priceCents, locale)}
                                  {rule.memberPriceCents !== null
                                    ? ` · ${t('memberShort', { amount: formatEuro(rule.memberPriceCents, locale) })}`
                                    : ''}
                                </span>
                                <form action={removePriceRuleAction}>
                                  <input type="hidden" name="slug" value={slug} />
                                  <input type="hidden" name="ruleId" value={rule.id} />
                                  <Button type="submit" variant="secondary" size="sm">
                                    {t('removeRule')}
                                  </Button>
                                </form>
                              </li>
                            ))}
                          </ul>
                        )}
                        <form action={addPriceRuleAction} className="space-y-2">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="serviceId" value={service.id} />
                          <div className="flex flex-wrap gap-x-3">
                            {WEEKDAYS.map((code, i) => (
                              <label
                                key={code}
                                className="flex min-h-11 items-center gap-1 text-body-sm"
                              >
                                <input
                                  type="checkbox"
                                  name="weekdays"
                                  value={i + 1}
                                  className="size-4 accent-[var(--brand)]"
                                />
                                {tClub(`weekday.${code}`)}
                              </label>
                            ))}
                          </div>
                          <div className="flex flex-wrap items-end gap-2">
                            <label className={small}>
                              {t('from')}
                              <Input name="from" type="time" size="sm" required className="mt-1" />
                            </label>
                            <label className={small}>
                              {t('to')}
                              <Input name="to" type="time" size="sm" required className="mt-1" />
                            </label>
                            <label className={small}>
                              {t('price')}
                              <Input
                                name="price"
                                inputMode="decimal"
                                size="sm"
                                required
                                className="mt-1 w-24"
                              />
                            </label>
                            <label className={small}>
                              {t('memberPrice')}
                              <Input
                                name="memberPrice"
                                inputMode="decimal"
                                size="sm"
                                className="mt-1 w-24"
                              />
                            </label>
                            <Button type="submit" variant="secondary" size="sm">
                              {t('addRule')}
                            </Button>
                          </div>
                        </form>
                      </div>
                      <form action={archiveServiceAction} className="mt-3">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="serviceId" value={service.id} />
                        <input type="hidden" name="archive" value={service.archived ? '0' : '1'} />
                        <ConfirmButton
                          message={service.archived ? t('restoreConfirm') : t('archiveConfirm')}
                          className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
                        >
                          {service.archived ? t('restore') : t('archive')}
                        </ConfirmButton>
                      </form>
                    </details>
                  </li>
                );
              })}
            </ul>
            <details className="rounded-card border border-dashed border-line-strong p-3">
              <summary className="cursor-pointer text-body-sm font-semibold text-ink">
                {t('add')}
              </summary>
              <form action={saveServiceAction} className="mt-2 space-y-3">
                {serviceFields(null)}
                <Button type="submit" size="sm">
                  {t('add')}
                </Button>
              </form>
            </details>
          </section>

          <section id="trainers" className={section} aria-labelledby="trainers-h">
            <h2 id="trainers-h" className="text-h4 font-bold text-ink">
              {t('hoursTitle')}
            </h2>
            <p className="text-caption text-text-muted">{t('hoursHint')}</p>
            {staff.map((s) =>
              locations.map((location) => (
                <details
                  key={`${s.userId}-${location.id}`}
                  className="rounded-card border border-line p-3"
                >
                  <summary className="cursor-pointer text-body-sm font-semibold text-ink">
                    {s.name}
                    {locations.length > 1 ? ` · ${location.name}` : ''}
                  </summary>
                  <form action={saveStaffHoursAction} className="mt-2 space-y-2">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="staffUserId" value={s.userId} />
                    <input type="hidden" name="locationId" value={location.id} />
                    <div className="grid gap-2 sm:grid-cols-2">
                      {WEEKDAYS.map((code, i) => {
                        const day = hours.find(
                          (h) =>
                            h.staffUserId === s.userId &&
                            h.locationId === location.id &&
                            h.weekday === i + 1,
                        );
                        return (
                          <div key={code} className="flex items-center gap-2">
                            <span className="w-8 text-body-sm font-semibold text-ink">
                              {tClub(`weekday.${code}`)}
                            </span>
                            <Input
                              name={`h${String(i + 1)}_opens`}
                              type="time"
                              size="sm"
                              aria-label={`${tClub(`weekday.${code}`)} ${t('from')}`}
                              defaultValue={day?.opens ?? ''}
                            />
                            <span aria-hidden="true">–</span>
                            <Input
                              name={`h${String(i + 1)}_closes`}
                              type="time"
                              size="sm"
                              aria-label={`${tClub(`weekday.${code}`)} ${t('to')}`}
                              defaultValue={day?.closes === '24:00' ? '00:00' : (day?.closes ?? '')}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <Button type="submit" variant="secondary" size="sm">
                      {t('saveHours')}
                    </Button>
                  </form>
                </details>
              )),
            )}
          </section>
        </>
      )}
    </main>
  );
}
