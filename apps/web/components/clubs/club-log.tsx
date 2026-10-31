import { getLocale, getTranslations } from 'next-intl/server';

import type { ClubAuditEntry } from '@/lib/clubs/audit';
import { formatDateTime } from '@/lib/format';

/**
 * The club's own accountability log (0039 club_audit) as a compact list —
 * who did what, when. A person whose account is gone reads as the "former
 * user" label and the row stays: the log is append-only by design.
 */
export async function ClubLog({ entries }: { entries: ClubAuditEntry[] }) {
  const [t, tAudit, tClub, locale] = await Promise.all([
    getTranslations('ClubMembers.audit'),
    getTranslations('ClubAudit.action'),
    getTranslations('Club'),
    getLocale(),
  ]);
  if (entries.length === 0) return <p className="text-body-sm text-text-muted">{t('empty')}</p>;
  const who = (entry: ClubAuditEntry): string => {
    switch (entry.actorKind) {
      case 'system':
        return t('system');
      case 'kiosk':
        return t('kiosk');
      case 'door':
        return t('door');
      case 'api':
        // The key's creator, through the key (0057).
        return t('api', { name: entry.actorName ?? tClub('formerUser') });
      case 'member':
        return entry.actorName ?? t('member');
      case 'ngo_admin':
        return t('ngo');
      default:
        return entry.actorName ?? tClub('formerUser');
    }
  };
  return (
    <ol className="divide-y divide-line">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-body-sm"
        >
          <span className="text-ink">
            {tAudit(entry.action)}
            {entry.subjectName ? ` · ${entry.subjectName}` : ''}
          </span>
          <span className="text-caption text-text-muted">
            {who(entry)} · {formatDateTime(entry.actedAt, locale)}
          </span>
        </li>
      ))}
    </ol>
  );
}
