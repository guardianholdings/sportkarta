import { CalendarDays } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { formatDateTime } from '@/lib/format';
import { facilitySessions, type FacilitySession } from '@/lib/sessions/occurrence';

/**
 * The next public игри held at this facility (UX audit N7). A sibling of
 * the club block, never inside FacilityDetailView (whose props feed the
 * JSON-LD). Renders nothing when there is none, or when the query fails — a
 * facility page must not wear a sessions outage. Names nobody: indexed page.
 */
export async function FacilitySessionsBlock({ facilityId }: { facilityId: string }) {
  let sessions: FacilitySession[];
  try {
    sessions = await facilitySessions(facilityId);
  } catch {
    return null;
  }
  if (sessions.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations('Session'), getLocale()]);

  return (
    <section
      aria-labelledby="facility-sessions-h"
      className="rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5"
    >
      <h2 id="facility-sessions-h" className="flex items-center gap-2 text-h4 font-bold text-ink">
        <CalendarDays size={18} className="text-brand" aria-hidden />
        {t('here.title')}
      </h2>
      <ul className="mt-2 divide-y divide-line">
        {sessions.map((s) => (
          <li key={s.occurrenceId}>
            <Link
              href={`/igra/${s.occurrenceId}`}
              className="flex min-h-11 items-center justify-between gap-3 py-2 text-body-sm hover:text-brand"
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold text-ink">{s.title}</span>
                <span className="block text-caption text-text-muted">
                  {formatDateTime(s.startsAt, locale)}
                </span>
              </span>
              {s.capacity !== null && (
                <span className="shrink-0 font-mono text-caption tabular-nums text-text-muted">
                  {t('here.places', { going: s.going, capacity: s.capacity })}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
