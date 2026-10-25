import { euroInputValue } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { PlanForm } from '@/components/clubs/sales-forms';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages, planFormLabels } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { planById } from '@/lib/clubs/sales';

import { savePlanAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function EditPlanPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string; planId: string }>;
}) {
  const { locale, slug, planId } = await params;
  setRequestLocale(locale);
  if (!isUuid(planId)) notFound();
  const { actor } = await requireClubStaff(slug, 'plans.manage');
  const plan = await planById(actor, planId);
  if (!plan) notFound();
  const [t, labels, messages] = await Promise.all([
    getTranslations('ClubSales'),
    planFormLabels(),
    clubFormMessages(),
  ]);
  return (
    <main className="mx-auto max-w-2xl space-y-4">
      <Link
        href={`/klub/${slug}/abonamenti`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('plansTitle')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('planForm.titleEdit')}</h1>
      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <PlanForm
          action={savePlanAction}
          slug={slug}
          labels={labels}
          messages={messages}
          plan={{ ...plan, price: euroInputValue(plan.priceCents, locale) }}
        />
      </section>
    </main>
  );
}
