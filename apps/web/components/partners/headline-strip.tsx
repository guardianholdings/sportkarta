import { getDb } from '@sportkarta/db';
import { getLocale, getTranslations } from 'next-intl/server';

import { headlinePartners, partnerText } from '@/lib/partners';

/**
 * The "с подкрепата на" headline-partner strip (docs/MONETISATION.md M1,
 * "optional in M1 — operator decision §7.2").
 *
 * TWO GATES, BOTH DELIBERATE.
 *
 * 1. AN ENV FLAG, SHIPPING OFF (`PARTNER_STRIP_ENABLED`, the
 *    AUTH_GOOGLE_ENABLED pattern). Whether a corporate logo appears beside our
 *    own content is a brand decision the plan explicitly reserved for the
 *    operator, and it is not the kind of decision that should be made by
 *    creating a partner row for `/partnyori`. So the code exists, the switch is
 *    documented in .env.example, and the default is no strip anywhere. Read at
 *    request time, so flipping it is a compose change and not a rebuild.
 * 2. A SURFACE ALLOWLIST, ENFORCED BY IMPORT SITES. This component is not
 *    mounted in a layout and must never be: a strip in the shell is a
 *    site-wide strip by another name. It is placed by hand on the two surfaces
 *    the plan allows — the `/kampanii` index and the `/igrishta/[city]` pages.
 *    Permanently excluded, and each for its own reason: passport pages (a
 *    corporate logo on a page about one named member), `/obshtina`
 *    accountability pages (a sponsor logo under the metrics that hold mayors
 *    accountable), `/danni`, and the map, which stays public infrastructure.
 *
 * The strip renders NOTHING when the flag is off, when no headline partner is
 * renderable, or when one exists but has no logo to show — never a placeholder
 * or an empty bordered box, which would advertise that the slot is for sale.
 *
 * Links carry rel="sponsored noopener": a paid placement must not pass
 * PageRank, and the collateral damage of getting that wrong would land on the
 * `/igrishta` SEO pages this strip sits on.
 */
export async function HeadlineStrip() {
  if (process.env.PARTNER_STRIP_ENABLED !== 'true') return null;

  const partners = (await headlinePartners(getDb())).filter((p) => p.logoPath !== null);
  if (partners.length === 0) return null;

  const [t, locale] = await Promise.all([getTranslations('Partners'), getLocale()]);

  return (
    <aside
      aria-label={t('stripLabel')}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4"
    >
      <span className="text-caption text-text-muted">{t('stripLabel')}</span>
      {partners.map((partner) => {
        const name = partnerText(partner.nameBg, partner.nameEn, locale) ?? partner.nameBg;
        const logo = (
          /* eslint-disable-next-line @next/next/no-img-element -- row-decides
             route on our own origin; a fixed 40px logo gains nothing from
             next/image, and the strip must not add a client-side dependency */
          <img
            src={`/api/partners/logo/${String(partner.id)}`}
            alt={name}
            width={40}
            height={40}
            className="size-10 shrink-0 object-contain"
          />
        );
        return partner.url ? (
          <a
            key={partner.id}
            href={partner.url}
            target="_blank"
            rel="sponsored noopener"
            // The 44px floor comes from the padded link box, not a bigger logo.
            className="inline-flex min-h-11 min-w-11 items-center justify-center hover:opacity-80"
          >
            {logo}
          </a>
        ) : (
          <span key={partner.id}>{logo}</span>
        );
      })}
    </aside>
  );
}
