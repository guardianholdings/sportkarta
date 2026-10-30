import { getTranslations, setRequestLocale } from 'next-intl/server';

import { EventFields } from '@/components/clubs/event-fields';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { clubSportOptions } from '@/lib/clubs/labels';
import { clubResources } from '@/lib/clubs/resources';
import { clubLocations } from '@/lib/clubs/settings';

import { saveEventAction } from '../actions';

export const dynamic = 'force-dynamic';

/** A new event (0053): saved as a draft — tickets next, then «Публикувай». */
export default async function NewClubEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'events.manage');
  const [t, messages, sports, locations, resources] = await Promise.all([
    getTranslations('ClubEvents'),
    clubFormMessages(),
    clubSportOptions(locale),
    clubLocations(actor),
    clubResources(actor),
  ]);
  const { rezultat } = await searchParams;
  const active = locations.filter((location) => location.active);

  return (
    <main className="mx-auto max-w-3xl space-y-4">
      <Link
        href={`/klub/${slug}/sabitiya`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('title')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('form.titleNew')}</h1>
      {rezultat && (
        <p
          role="status"
          className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
        >
          {rezultat === 'readOnly'
            ? messages.readOnly
            : (messages.errors[rezultat] ?? messages.genericError)}
        </p>
      )}
      {active.length === 0 ? (
        <p className="rounded-card border border-warning-border bg-warning-bg p-4 text-body-sm text-ink">
          {t('form.needLocation')}{' '}
          <Link href={`/klub/${slug}/nastroyki`} className="font-semibold text-link">
            {t('form.toSettings')}
          </Link>
        </p>
      ) : (
        <form
          action={saveEventAction}
          className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm"
        >
          <EventFields
            slug={slug}
            event={null}
            locations={active}
            resources={resources.filter((r) => !r.archived)}
            sports={sports}
          />
          <p className="text-caption text-text-muted">{t('form.draftHint')}</p>
          <Button type="submit">{t('form.create')}</Button>
        </form>
      )}
    </main>
  );
}
