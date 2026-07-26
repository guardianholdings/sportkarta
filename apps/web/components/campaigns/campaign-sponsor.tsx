import { getDb } from '@sportkarta/db';
import { getLocale, getTranslations } from 'next-intl/server';

import { campaignSponsor, partnerText } from '@/lib/partners';

/**
 * "Кампанията се осъществява с подкрепата на X" (docs/MONETISATION.md S2, M2).
 *
 * THE SPONSOR BLOCK IS CONTENT, NOT AUTHORITY. It renders a name, a logo and a
 * link beside the campaign's own text. What the sponsor bought is this block and
 * the prize; what they did not buy is the scoring (a closed grammar), the
 * participant list (the public board joins the consent view, the admin board is
 * `requireRole('admin')` and exists so the operator can hand over a prize), or
 * any presence in `campaign_results`, which stores no display data at all.
 *
 * IT READS THE PARTNER LIVE, through `campaignSponsor`'s renderability rule —
 * so hiding a partner or letting their window lapse withdraws this block from
 * every campaign at once, including from a closed campaign's results page.
 * Nothing about the sponsor is copied onto the campaign row, precisely so there
 * is no second place for a lapsed sponsor to keep appearing from.
 *
 * Renders NOTHING for an unsponsored campaign (the normal case) or for a
 * sponsor who is no longer renderable.
 */
export async function CampaignSponsor({ partnerId }: { partnerId: number | null }) {
  if (partnerId === null) return null;

  const partner = await campaignSponsor(getDb(), partnerId);
  if (!partner) return null;

  const [t, locale] = await Promise.all([getTranslations('Campaign'), getLocale()]);
  const name = partnerText(partner.nameBg, partner.nameEn, locale) ?? partner.nameBg;

  const body = (
    <span className="inline-flex items-center gap-2">
      {partner.logoPath && (
        /* eslint-disable-next-line @next/next/no-img-element -- row-decides route
           on our own origin; a 32px logo gains nothing from next/image */
        <img
          src={`/api/partners/logo/${String(partner.id)}`}
          alt={name}
          width={32}
          height={32}
          className="size-8 shrink-0 object-contain"
        />
      )}
      <span className="font-semibold text-ink">{name}</span>
    </span>
  );

  return (
    <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-soft">
      <span>{t('sponsoredBy')}</span>
      {partner.url ? (
        /* sponsored: a paid placement must not pass PageRank. */
        <a href={partner.url} target="_blank" rel="sponsored noopener" className="hover:opacity-90">
          {body}
        </a>
      ) : (
        body
      )}
    </p>
  );
}
