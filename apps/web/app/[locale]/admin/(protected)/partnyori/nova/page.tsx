import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireRole } from '@/lib/auth-session';
import { Link } from '@/i18n/navigation';

import { createPartnerAction } from '../actions';
import { partnerFormLabels } from '../form-labels';
import { PartnerForm } from '../partner-form';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

type PageParams = Promise<{ locale: string }>;

export default async function NewPartnerPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const [t, labels] = await Promise.all([getTranslations('AdminPartners'), partnerFormLabels()]);

  return (
    <main className="max-w-2xl space-y-6">
      <Link
        href="/admin/partnyori"
        className="text-body-sm font-medium text-link hover:text-link-hover"
      >
        {t('backToList')}
      </Link>
      <h1 className="text-h3 font-bold text-ink">{t('newPartner')}</h1>
      <PartnerForm action={createPartnerAction} labels={labels} />
    </main>
  );
}
