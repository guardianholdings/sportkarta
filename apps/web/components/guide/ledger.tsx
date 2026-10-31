import { getTranslations } from 'next-intl/server';

import { POINTS_BY_EVENT, POINTS_EVENTS } from '@sportkarta/lib/points';

/**
 * «Колко точки носи всяко действие» — read from the ledger's own price list
 * (lib/src/points.ts), so the page cannot quote a number the ledger does not
 * pay. Each row says how often it pays, which is the anti-farming rule the
 * award key enforces.
 */
export async function Ledger() {
  const t = await getTranslations('Home.guide.passport.ledger');
  return (
    <div className="mt-10 rounded-card border border-line bg-surface p-5 shadow-xs sm:p-6">
      <table className="w-full border-collapse text-left">
        <caption className="mb-4 text-left text-h4 font-extrabold tracking-tight text-ink">
          {t('title')}
        </caption>
        <tbody>
          {POINTS_EVENTS.map((event) => (
            <tr key={event} className="border-t border-line first:border-t-0">
              <td className="w-16 py-3 pr-3 align-top">
                <span className="sk-ledger-coin" aria-hidden="true">
                  {t('points', { count: POINTS_BY_EVENT[event] })}
                </span>
                <span className="sr-only">
                  {t('pointsLabel', { count: POINTS_BY_EVENT[event] })}
                </span>
              </td>
              <th scope="row" className="py-3 align-top font-normal">
                <span className="block text-body font-bold text-ink">{t(`${event}.label`)}</span>
                <span className="block text-body-sm text-ink-soft">{t(`${event}.rule`)}</span>
              </th>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-caption text-text-muted">{t('note')}</p>
    </div>
  );
}
