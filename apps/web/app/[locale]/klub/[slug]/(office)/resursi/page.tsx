import { sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { CLUB_RESOURCE_KINDS } from '@/lib/clubs/input';
import {
  clubResources,
  locationHours,
  upcomingResourceBlocks,
  type ClubResource,
} from '@/lib/clubs/resources';
import { clubLocations } from '@/lib/clubs/settings';
import { formatDateTime } from '@/lib/format';
import { formErrorText, isPlainCode } from '@/lib/clubs/form-error';

import {
  addBlockAction,
  archiveResourceAction,
  removeBlockAction,
  saveHoursAction,
  saveResourceAction,
} from './actions';

export const dynamic = 'force-dynamic';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

/**
 * Courts, rooms and equipment (0048, wave C): what can be booked, where, how
 * many of it, when each location is open, and closures for maintenance or an
 * event. Bookings themselves live on «Резервации».
 */
export default async function ClubResourcesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const [t, tClub, messages, locations, resources, blocks] = await Promise.all([
    getTranslations('ClubResources'),
    getTranslations('Club'),
    clubFormMessages(),
    clubLocations(actor),
    clubResources(actor, { includeArchived: true }),
    upcomingResourceBlocks(actor),
  ]);
  const hours = await Promise.all(locations.map((l) => locationHours(actor, l.id)));
  const { rezultat } = await searchParams;
  const canBlock = actorCan(actor, 'schedule.manage');
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const live = resources.filter((r) => !r.archived);

  const resourceFields = (resource: ClubResource | null) => (
    <>
      <input type="hidden" name="slug" value={slug} />
      {resource && <input type="hidden" name="resourceId" value={resource.id} />}
      <label className={field}>
        {t('name')}
        <Input
          name="name"
          required
          maxLength={80}
          defaultValue={resource?.name ?? ''}
          className="mt-1"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={field}>
          {t('kind')}
          <Select name="kind" defaultValue={resource?.kind ?? 'court'} className="mt-1">
            {CLUB_RESOURCE_KINDS.map((kind) => (
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
            defaultValue={resource?.locationId ?? locations[0]?.id}
            className="mt-1"
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
        <label className={field}>
          {t('quantity')}
          <Input
            name="quantity"
            type="number"
            min={1}
            max={500}
            defaultValue={resource?.quantity ?? 1}
            className="mt-1"
          />
        </label>
      </div>
      <p className="text-caption text-text-muted">{t('quantityHint')}</p>
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
          <section className={section} aria-labelledby="res-h">
            <h2 id="res-h" className="text-h4 font-bold text-ink">
              {t('listTitle')}
            </h2>
            {resources.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('empty')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {resources.map((resource) => (
                  <li key={resource.id} className="py-2">
                    <details>
                      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-body-sm">
                        <span className="font-semibold text-ink">{resource.name}</span>
                        <span className="text-caption text-text-muted">
                          {t(`kinds.${resource.kind}`)} · {resource.locationName}
                          {resource.quantity > 1 ? ` · ×${String(resource.quantity)}` : ''}
                          {resource.archived ? ` · ${t('archived')}` : ''}
                        </span>
                      </summary>
                      <form action={saveResourceAction} className="mt-2 space-y-3">
                        {resourceFields(resource)}
                        <Button type="submit" size="sm">
                          {t('save')}
                        </Button>
                      </form>
                      <form action={archiveResourceAction} className="mt-2">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="resourceId" value={resource.id} />
                        <input type="hidden" name="archive" value={resource.archived ? '0' : '1'} />
                        <ConfirmButton
                          message={resource.archived ? t('restoreConfirm') : t('archiveConfirm')}
                          className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
                        >
                          {resource.archived ? t('restore') : t('archive')}
                        </ConfirmButton>
                      </form>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            <details className="rounded-card border border-dashed border-line-strong p-3">
              <summary className="cursor-pointer text-body-sm font-semibold text-ink">
                {t('add')}
              </summary>
              <form action={saveResourceAction} className="mt-2 space-y-3">
                {resourceFields(null)}
                <Button type="submit" size="sm">
                  {t('add')}
                </Button>
              </form>
            </details>
          </section>

          <section className={section} aria-labelledby="hours-h">
            <h2 id="hours-h" className="text-h4 font-bold text-ink">
              {t('hoursTitle')}
            </h2>
            <p className="text-caption text-text-muted">{t('hoursHint')}</p>
            {locations.map((location, index) => (
              <form key={location.id} action={saveHoursAction} className="space-y-2">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="locationId" value={location.id} />
                <h3 className="text-body font-bold text-ink">{location.name}</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {WEEKDAYS.map((code, i) => {
                    const day = hours[index]?.find((h) => h.weekday === i + 1);
                    return (
                      <div key={code} className="flex items-center gap-2">
                        <span className="w-8 text-body-sm font-semibold text-ink">
                          {tClub(`weekday.${code}`)}
                        </span>
                        <Input
                          name={`h${String(i + 1)}_opens`}
                          type="time"
                          size="sm"
                          aria-label={`${tClub(`weekday.${code}`)} ${t('opens')}`}
                          defaultValue={day?.opens ?? ''}
                        />
                        <span aria-hidden="true">–</span>
                        <Input
                          name={`h${String(i + 1)}_closes`}
                          type="time"
                          size="sm"
                          aria-label={`${tClub(`weekday.${code}`)} ${t('closes')}`}
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
            ))}
          </section>

          {canBlock && live.length > 0 && (
            <section className={section} aria-labelledby="blocks-h">
              <h2 id="blocks-h" className="text-h4 font-bold text-ink">
                {t('blocksTitle')}
              </h2>
              <p className="text-caption text-text-muted">{t('blocksHint')}</p>
              {blocks.length > 0 && (
                <ul className="divide-y divide-line">
                  {blocks.map((block) => (
                    <li
                      key={block.id}
                      className="flex flex-wrap items-center gap-2 py-2 text-body-sm"
                    >
                      <span className="min-w-0 flex-1 text-ink">
                        {block.resourceName} · {formatDateTime(block.startsAt, locale)} –{' '}
                        {formatDateTime(block.endsAt, locale)}
                      </span>
                      {block.eventId ? (
                        <Link
                          href={`/klub/${slug}/sabitiya/${block.eventId}`}
                          className="text-body-sm font-semibold text-link hover:text-link-hover"
                        >
                          {t('eventBlock')}
                        </Link>
                      ) : (
                        <form action={removeBlockAction}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="blockId" value={block.id} />
                          <Button type="submit" variant="secondary" size="sm">
                            {t('removeBlock')}
                          </Button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <form action={addBlockAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="slug" value={slug} />
                <label className="text-caption text-ink-soft">
                  {t('resource')}
                  <Select name="resourceId" size="sm" className="mt-1">
                    {live.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="text-caption text-ink-soft">
                  {t('date')}
                  <Input
                    name="date"
                    type="date"
                    size="sm"
                    required
                    defaultValue={sofiaToday()}
                    className="mt-1"
                  />
                </label>
                <label className="text-caption text-ink-soft">
                  {t('from')}
                  <Input name="from" type="time" size="sm" required className="mt-1" />
                </label>
                <label className="text-caption text-ink-soft">
                  {t('to')}
                  <Input name="to" type="time" size="sm" required className="mt-1" />
                </label>
                <Button type="submit" size="sm">
                  {t('addBlock')}
                </Button>
              </form>
            </section>
          )}
        </>
      )}
    </main>
  );
}
