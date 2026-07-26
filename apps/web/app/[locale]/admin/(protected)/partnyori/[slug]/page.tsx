import { getDb } from '@sportkarta/db';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireRole } from '@/lib/auth-session';
import { partnerBySlug } from '@/lib/partners';
import { Link } from '@/i18n/navigation';

import { updatePartnerAction } from '../actions';
import { partnerFormLabels } from '../form-labels';
import { PartnerForm } from '../partner-form';
import { PlacementsPanel } from '../placements-panel';
import { SponsorshipsPanel } from '../sponsorships-panel';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

type PageParams = Promise<{ locale: string; slug: string }>;

export default async function EditPartnerPage({ params }: { params: PageParams }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const [t, labels, partner] = await Promise.all([
    getTranslations('AdminPartners'),
    partnerFormLabels(),
    partnerBySlug(getDb(), slug),
  ]);
  if (!partner) notFound();

  return (
    <main className="max-w-2xl space-y-6">
      <Link
        href="/admin/partnyori"
        className="text-body-sm font-medium text-link hover:text-link-hover"
      >
        {t('backToList')}
      </Link>
      <header className="flex items-center gap-3">
        <h1 className="text-h3 font-bold text-ink">{partner.nameBg}</h1>
        {partner.logoPath && (
          /* eslint-disable-next-line @next/next/no-img-element -- served by
             our own row-decides route; next/image adds nothing for a 48px logo */
          <img
            src={`/api/partners/logo/${String(partner.id)}`}
            alt=""
            width={48}
            height={48}
            className="rounded-md border border-line bg-surface object-contain"
          />
        )}
      </header>
      <PartnerForm
        action={updatePartnerAction.bind(null, partner.slug)}
        labels={labels}
        partner={partner}
      />
      {/* Ad placements live on the partner's own screen (MONETISATION M4): an
          advertiser IS a partner row, so their slots belong here rather than in
          a separate admin section. Shown for every tier, not just 'advertiser'
          — a headline sponsor who also buys a slot is a real deal shape. */}
      <PlacementsPanel partnerId={partner.id} partnerSlug={partner.slug} />
      {/* Adopt-a-facility (MONETISATION M3a), same screen and same reason. */}
      <SponsorshipsPanel partnerId={partner.id} partnerSlug={partner.slug} />
    </main>
  );
}
