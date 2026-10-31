import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import { CLUB_TRIAL_DAYS } from '@sportkarta/lib/clubs';

const STEPS = ['apply', 'review', 'trial', 'invoice'] as const;
const TRANSFER = ['import', 'team', 'publish'] as const;

/** «Как става» — the four steps from the form to the first invoice, and the three of a move. */
export async function Steps() {
  const t = await getTranslations('ClubsLanding.steps');
  return (
    <section
      aria-labelledby="clubs-steps"
      className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20"
    >
      <SectionHead id="clubs-steps" overline={t('overline')} title={t('title')} lead={t('lead')} />
      <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((key, index) => (
          <li
            key={key}
            className="flex flex-col gap-2 rounded-card border border-line bg-surface p-5"
          >
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-full bg-accent font-mono text-body-sm font-bold text-on-accent"
            >
              {index + 1}
            </span>
            <span className="text-body font-bold text-ink">{t(`${key}.title`)}</span>
            <span className="text-body-sm text-ink-soft">
              {t(`${key}.body`, { days: CLUB_TRIAL_DAYS })}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-10 rounded-card border border-brand-border bg-brand-subtle p-6">
        <h3 className="text-h4 font-extrabold tracking-tight text-ink">{t('transferTitle')}</h3>
        <p className="mt-1 text-body-sm text-ink-soft">{t('transferLead')}</p>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {TRANSFER.map((key, index) => (
            <li key={key} className="flex items-start gap-3 text-body-sm text-ink">
              <span
                aria-hidden="true"
                className="grid size-6 shrink-0 place-items-center rounded-full bg-brand font-mono text-caption font-bold text-on-brand"
              >
                {index + 1}
              </span>
              <span>
                <span className="block font-bold">{t(`transfer.${key}.title`)}</span>
                <span className="text-ink-soft">{t(`transfer.${key}.body`)}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
