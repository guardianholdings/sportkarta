import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { AdminActionEntry } from '@/lib/admin-actions';
import { cityDisplayName } from '@/lib/city-names';

/**
 * The `admin_actions` log as a compact table (0033) — "who changed what, and
 * when", answered on the screen where the change is made: an account's page,
 * /admin/ambasadori and /admin/chastni.
 *
 * Only ever rendered on admin-only screens; the entries carry account emails.
 * An actor or subject whose account has since been erased resolves to nothing
 * and reads as the "former user" label — the row itself survives, by design.
 *
 * `showSubject` is off on an account's own page, where every row is about the
 * same person and repeating their name is noise.
 */
export async function AdminActionLog({
  entries,
  showSubject = true,
}: {
  entries: AdminActionEntry[];
  showSubject?: boolean;
}) {
  const [t, locale] = await Promise.all([getTranslations('AdminAccounts.actionLog'), getLocale()]);
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Sofia',
  });

  if (entries.length === 0) {
    return <p className="text-body-sm text-text-muted">{t('empty')}</p>;
  }

  const describe = (entry: AdminActionEntry): string => {
    const detail = entry.detail;
    const municipality =
      entry.municipalityNameBg !== null
        ? cityDisplayName(entry.municipalityNameBg, entry.municipalityNameEn ?? '', locale)
        : t('unknown');
    switch (entry.action) {
      case 'account_suspended':
        return t('action.account_suspended', { sessions: Number(detail.sessionsRevoked ?? 0) });
      case 'display_name_reset':
        return t('action.display_name_reset', {
          madePrivate: detail.passportMadePrivate === true ? 'yes' : 'no',
        });
      case 'sessions_revoked':
        return t('action.sessions_revoked', { count: Number(detail.count ?? 0) });
      case 'ambassador_revoked':
        return t('action.ambassador_revoked', { scopes: Number(detail.scopesRemoved ?? 0) });
      case 'ambassador_scope_added':
      case 'ambassador_scope_removed':
        return t(`action.${entry.action}`, { municipality });
      case 'setting_changed':
        return t('action.setting_changed', { on: detail.value === 'true' ? 'yes' : 'no' });
      case 'business_visibility_changed':
        return t('action.business_visibility_changed', {
          business: entry.businessName ?? t('unknown'),
          visible: detail.visible === true ? 'yes' : 'no',
        });
      default:
        return t(`action.${entry.action}`);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line text-left text-caption text-text-muted">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {t('when')}
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {t('who')}
            </th>
            {showSubject && (
              <th scope="col" className="py-1.5 pr-3 font-medium">
                {t('subject')}
              </th>
            )}
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {t('what')}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-caption text-text-muted">
                {when.format(new Date(entry.actedAt))}
              </td>
              <td className="py-1.5 pr-3 text-ink">
                {entry.actorName || entry.actorEmail || t('formerUser')}
              </td>
              {showSubject && (
                <td className="py-1.5 pr-3 text-ink">
                  {entry.subjectId === null ? (
                    t('national')
                  ) : entry.subjectEmail === null ? (
                    t('formerUser')
                  ) : (
                    <Link
                      href={`/admin/akaunti/${entry.subjectId}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {entry.subjectName || entry.subjectEmail}
                    </Link>
                  )}
                </td>
              )}
              <td className="py-1.5 pr-3 text-ink">{describe(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
