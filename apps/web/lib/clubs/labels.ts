import { CLUB_SPORTS, isClubActivity } from '@sportkarta/lib/clubs';
import { getTranslations } from 'next-intl/server';

/**
 * Names for what a club offers: a canonical sport reads from the map's own
 * `Sport` namespace, a club activity (yoga, BJJ…) from `ClubActivities`, so a
 * sport is called the same thing on a facility page and on a club page.
 */
export async function clubSportLabeler(): Promise<(slug: string) => string> {
  const [tSport, tActivity] = await Promise.all([
    getTranslations('Sport'),
    getTranslations('ClubActivities'),
  ]);
  return (slug: string) => {
    if (isClubActivity(slug)) return tActivity(slug);
    return (CLUB_SPORTS as readonly string[]).includes(slug) ? tSport(slug) : slug;
  };
}

/** Every option for a sport picker, alphabetical in the page's language. */
export async function clubSportOptions(
  locale: string,
): Promise<{ value: string; label: string }[]> {
  const label = await clubSportLabeler();
  return CLUB_SPORTS.map((value) => ({ value, label: label(value) })).sort((a, b) =>
    a.label.localeCompare(b.label, locale),
  );
}
