import { sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { ClassForm } from '@/components/clubs/class-form';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { classFormLabels, clubFormMessages } from '@/lib/clubs/form-labels';
import { clubSportOptions } from '@/lib/clubs/labels';
import { listPlans } from '@/lib/clubs/sales';
import { clubLocations, clubSettings } from '@/lib/clubs/settings';
import { clubResources } from '@/lib/clubs/resources';
import { clubInstructors } from '@/lib/clubs/staff';

import { saveClassAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewClassPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const [t, labels, messages, sports, locations, instructors, plans, settings] = await Promise.all([
    getTranslations('ClubSchedule'),
    classFormLabels(),
    clubFormMessages(),
    clubSportOptions(locale),
    clubLocations(actor),
    clubInstructors(actor),
    listPlans(actor),
    clubSettings(actor.clubId),
  ]);
  const active = locations.filter((location) => location.active);

  return (
    <main className="mx-auto max-w-3xl space-y-4">
      <Link
        href={`/klub/${slug}/grafik`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('title')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('form.titleNew')}</h1>
      {active.length === 0 ? (
        <p className="rounded-card border border-warning-border bg-warning-bg p-4 text-body-sm text-ink">
          {t('form.needLocation')}{' '}
          <Link href={`/klub/${slug}/nastroyki`} className="font-semibold text-link">
            {t('form.toSettings')}
          </Link>
        </p>
      ) : (
        <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <ClassForm
            action={saveClassAction}
            slug={slug}
            labels={labels}
            messages={messages}
            sports={sports}
            locations={active.map((location) => ({ id: location.id, name: location.name }))}
            instructors={instructors}
            rooms={(await clubResources(actor)).map((r) => ({
              id: r.id,
              name: r.name,
              locationName: r.locationName,
            }))}
            plans={plans.map((plan) => ({
              id: plan.id,
              name: locale === 'en' && plan.nameEn ? plan.nameEn : plan.nameBg,
            }))}
            today={sofiaToday()}
            defaults={{
              bookingOpensDays: Math.max(1, Math.round((settings?.bookingOpensHours ?? 168) / 24)),
              cancelDeadlineHours: settings?.cancelDeadlineHours ?? 2,
            }}
          />
        </section>
      )}
    </main>
  );
}
