import { Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';

const QUESTIONS = [
  'free',
  'account',
  'who',
  'location',
  'gone',
  'organise',
  'delete',
  'data',
] as const;

/** The questions a first visit asks, answered in place — native disclosure, no script. */
export async function Faq() {
  const t = await getTranslations('Home.guide.faq');
  return (
    <section
      aria-labelledby="guide-faq"
      className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8 lg:py-24"
    >
      <SectionHead id="guide-faq" overline={t('overline')} title={t('title')} />
      <div className="mt-8 grid gap-x-8 lg:grid-cols-2">
        {QUESTIONS.map((key) => (
          <details key={key} className="sk-faq group border-b border-line">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-body font-bold text-ink">
              {t(`${key}.q`)}
              <Plus
                size={20}
                aria-hidden="true"
                className="shrink-0 text-accent-active transition-transform duration-150 ease-standard group-open:rotate-45"
              />
            </summary>
            <p className="pb-5 text-body-sm text-ink-soft">{t(`${key}.a`)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
