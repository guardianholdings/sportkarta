import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PlanForm } from '@/components/clubs/sales-forms';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages, planFormLabels } from '@/lib/clubs/form-labels';

import { savePlanAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewPlanPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireClubStaff(slug, 'plans.manage');
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
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('planForm.titleNew')}</h1>
      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <PlanForm action={savePlanAction} slug={slug} labels={labels} messages={messages} />
      </section>
    </main>
  );
}
