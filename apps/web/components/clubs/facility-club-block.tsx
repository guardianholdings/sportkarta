import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { clubsEnabled } from '@/lib/clubs/access';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { facilityClubs, type FacilityClub } from '@/lib/clubs/public';
import { formatDateTime } from '@/lib/format';

/**
 * Clubs that hold classes AT this facility (Stage 9, plan §6.5). A sibling of
 * the sponsor block, never inside FacilityDetailView — whose props feed the
 * JSON-LD and the provenance line — and LABELLED «Платено представяне»: every
 * tier is paid (2026-10-31), so every club block is commercial content beside
 * our own, never mistaken for it (the AdCreative precedent).
 *
 * Renders nothing when the add-on is off, when no renderable club is here, or
 * when the query fails — a facility page must never wear a club's outage.
 */
export async function FacilityClubBlock({ facilityId }: { facilityId: string }) {
  if (!clubsEnabled()) return null;
  const locale = await getLocale();
  let clubs: FacilityClub[];
  try {
    clubs = await facilityClubs(facilityId, locale);
  } catch {
    return null;
  }
  if (clubs.length === 0) return null;
  const [t, sportLabel] = await Promise.all([getTranslations('ClubPublic'), clubSportLabeler()]);

  return (
    <>
      {clubs.map((club, i) => (
        <section
          key={club.id}
          // `#klubove` is where the map's «Клуб на това съоръжение» lands when
          // more than one club trains here (map-explorer.tsx, FacilityPreview).
          id={i === 0 ? 'klubove' : undefined}
          className="scroll-mt-4 rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5"

          aria-labelledby={`club-${club.id}`}
        >
          <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
            {t('block.paid')}
          </p>
          <div className="mt-2 flex items-center gap-3">
            {club.hasLogo && (
              // eslint-disable-next-line @next/next/no-img-element -- the row-decides logo route
              <img
                src={`/api/clubs/logo/${club.id}`}
                alt=""
                width={40}
                height={40}
                className="size-10 shrink-0 object-contain"
              />
            )}
            <h2 id={`club-${club.id}`} className="text-h4 font-bold text-ink">
              {club.name}
            </h2>
          </div>
          {club.sports.length > 0 && (
            <p className="mt-1 text-caption text-text-muted">
              {club.sports.slice(0, 5).map(sportLabel).join(' · ')}
            </p>
          )}
          {club.next.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-caption font-semibold text-ink-soft">{t('block.next')}</p>
              <ul className="space-y-1 text-body-sm">
                {club.next.map((cls) => (
                  <li key={cls.occurrenceId}>
                    <Link
                      href={`/klub/${club.slug}/trenirovka/${cls.occurrenceId}`}
                      className="text-link hover:text-link-hover"
                    >
                      {cls.title} · {formatDateTime(cls.startsAt, locale)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Link
            href={`/klub/${club.slug}`}
            className="mt-3 inline-flex min-h-11 items-center text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {t('block.page')}
          </Link>
        </section>
      ))}
    </>
  );
}
