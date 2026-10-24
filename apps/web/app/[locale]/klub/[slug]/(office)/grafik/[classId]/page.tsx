import { sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ClassForm } from '@/components/clubs/class-form';
import { buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { classFormLabels, classFormValues, clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { clubSportOptions } from '@/lib/clubs/labels';
import { listPlans } from '@/lib/clubs/sales';
import { classById } from '@/lib/clubs/schedule';
import { clubLocations, clubSettings } from '@/lib/clubs/settings';
import { clubInstructors } from '@/lib/clubs/staff';

import { cancelClassAction, saveClassAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function EditClassPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string; classId: string }>;
}) {
  const { locale, slug, classId } = await params;
  setRequestLocale(locale);
  if (!isUuid(classId)) notFound();
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const cls = await classById(actor, classId);
  if (!cls) notFound();
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
  // The class's own location stays selectable even after it was deactivated.
  const usable = locations.filter((location) => location.active || location.id === cls.locationId);
  const cancelled = cls.status === 'cancelled';

  return (
    <main className="mx-auto max-w-3xl space-y-4">
      <Link
        href={`/klub/${slug}/grafik`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('title')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('form.titleEdit')}</h1>
      {cancelled ? (
        <p className="rounded-card border border-line bg-paper-sunk p-4 text-body-sm text-ink-soft">
          {t('form.seriesCancelled')}
        </p>
      ) : (
        <>
          <p className="max-w-prose text-body-sm text-ink-soft">{t('form.editNote')}</p>
          <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
            <ClassForm
              action={saveClassAction}
              slug={slug}
              labels={labels}
              messages={messages}
              sports={sports}
              locations={usable.map((location) => ({ id: location.id, name: location.name }))}
              instructors={instructors}
              plans={plans.map((plan) => ({
                id: plan.id,
                name: locale === 'en' && plan.nameEn ? plan.nameEn : plan.nameBg,
              }))}
              today={sofiaToday()}
              defaults={{
                bookingOpensDays: Math.max(
                  1,
                  Math.round((settings?.bookingOpensHours ?? 168) / 24),
                ),
                cancelDeadlineHours: settings?.cancelDeadlineHours ?? 2,
              }}
              value={classFormValues(cls, locale)}
            />
          </section>
          <section className="space-y-2 rounded-card border border-danger-border bg-danger-bg p-4">
            <h2 className="text-body font-bold text-ink">{t('form.cancelSeries')}</h2>
            <p className="max-w-prose text-body-sm text-ink-soft">{t('form.cancelSeriesHint')}</p>
            <form action={cancelClassAction}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="classId" value={cls.id} />
              <ConfirmButton
                message={t('form.cancelSeriesConfirm')}
                className={buttonVariants({ variant: 'danger' })}
              >
                {t('form.cancelSeries')}
              </ConfirmButton>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
