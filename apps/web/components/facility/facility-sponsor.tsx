import { getDb } from '@sportkarta/db';
import { getLocale, getTranslations } from 'next-intl/server';

import { facilitySponsor } from '@/lib/facility-sponsors';
import { partnerText } from '@/lib/partners';

/**
 * "Поддържа се от X" — the adopt-a-facility block (docs/MONETISATION.md S3, M3a).
 *
 * A FACTUAL CLAIM, ON A PLATFORM WHOSE BRAND IS VERIFIABLE DATA. The block says
 * somebody funds this facility's upkeep, so the operator publishes it only after
 * the funded work is evidenced (§S3) — the condition-report flow is that
 * evidence trail. Nothing in code can enforce that; what code enforces is that
 * the claim disappears the moment it stops being current: the sponsorship window
 * and the partner's own renderability are both join conditions
 * (lib/facility-sponsors.ts), so a lapsed adoption or a hidden partner leaves no
 * trace here.
 *
 * DELIBERATELY NOT ON THE MAP. The map-pin badge is M3b, and the plan gates it
 * behind a signed sponsor's explicit demand — it is the one place the map stops
 * being purely public infrastructure, and it is the deliverable sponsors care
 * about least. This block, the before/after photos and `/partnyori` are where
 * the PR story actually lives.
 *
 * Renders nothing when the facility is unadopted, which is almost always.
 */
export async function FacilitySponsorBlock({ facilityId }: { facilityId: string }) {
  const sponsor = await facilitySponsor(getDb(), facilityId);
  if (!sponsor) return null;

  const [t, locale] = await Promise.all([getTranslations('Facility'), getLocale()]);
  const name = partnerText(sponsor.nameBg, sponsor.nameEn, locale) ?? sponsor.nameBg;
  const label = partnerText(sponsor.labelBg, sponsor.labelEn, locale);

  const identity = (
    <span className="inline-flex items-center gap-2">
      {sponsor.logoPath && (
        /* eslint-disable-next-line @next/next/no-img-element -- row-decides route
           on our own origin; a 40px logo gains nothing from next/image */
        <img
          src={`/api/partners/logo/${String(sponsor.partnerId)}`}
          alt={name}
          width={40}
          height={40}
          className="size-10 shrink-0 object-contain"
        />
      )}
      <span className="font-semibold text-ink">{name}</span>
    </span>
  );

  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5">
      <h2 className="mb-2 text-h4 font-bold text-ink">{t('sponsorTitle')}</h2>
      <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-soft">
        {sponsor.url ? (
          /* sponsored: a paid acknowledgment must not pass PageRank, and these
             facility pages are the platform's highest-value SEO surface. */
          <a
            href={sponsor.url}
            target="_blank"
            rel="sponsored noopener"
            className="hover:opacity-90"
          >
            {identity}
          </a>
        ) : (
          identity
        )}
      </p>
      {label && <p className="mt-2 text-body-sm text-ink-soft">{label}</p>}
      {/* The end date is shown on purpose: an adoption is an annual arrangement
          over public infrastructure, and saying when it runs out is the
          difference between an acknowledgment and an implied claim. */}
      <p className="mt-2 text-caption text-text-muted">
        {t('sponsorUntil', { date: sponsor.endsOn })}
      </p>
    </section>
  );
}
