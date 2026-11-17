import { ChevronDown } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import {
  CLUB_CONTRACT_MONTHS,
  CLUB_CONTRACT_NOTICE_MONTHS,
  CLUB_TRIAL_DAYS,
  COMMUNITY_MEMBER_CAP,
} from '@sportkarta/lib/clubs';

export const FAQ_KEYS = [
  'trial',
  'money',
  'account',
  'minors',
  'switching',
  'cancel',
  'sms',
  'fiscal',
  'lapse',
  'trainer',
] as const;

/**
 * The questions the section asks and the answers it gives, resolved once — for
 * the section itself and for the page's structured data, so the markup cannot
 * state an answer the page does not print (the SMS question and the «скоро»
 * wording of the payments answer follow the same switches in both).
 */
export async function clubsFaq({
  paymentsOn,
  smsOn,
}: {
  paymentsOn: boolean;
  smsOn: boolean;
}): Promise<{ key: (typeof FAQ_KEYS)[number]; question: string; answer: string }[]> {
  const t = await getTranslations('ClubsLanding.faq');
  return FAQ_KEYS.filter((key) => key !== 'sms' || smsOn).map((key) => ({
    key,
    question: t(`${key}.q`),
    answer: t(key === 'money' && !paymentsOn ? 'money.aSoon' : `${key}.a`, {
      days: CLUB_TRIAL_DAYS,
      cap: COMMUNITY_MEMBER_CAP,
      months: CLUB_CONTRACT_MONTHS,
      notice: CLUB_CONTRACT_NOTICE_MONTHS,
    }),
  }));
}

/**
 * «Въпроси преди да започнете» — the objections an owner has before applying,
 * answered where they arise. Native <details>, so the page needs no script
 * for them and every answer is in the HTML for a crawler. The SMS question
 * is asked only while SMS is switched on (CLUB_SMS_ENABLED): the page never
 * prices a service it does not sell yet.
 */
export async function Faq({ paymentsOn, smsOn }: { paymentsOn: boolean; smsOn: boolean }) {
  const [t, entries] = await Promise.all([
    getTranslations('ClubsLanding.faq'),
    clubsFaq({ paymentsOn, smsOn }),
  ]);
  return (
    <section aria-labelledby="clubs-faq" className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <SectionHead id="clubs-faq" title={t('title')} />
        <div className="mt-8 grid gap-3 lg:grid-cols-2">
          {entries.map(({ key, question, answer }) => (
            <details key={key} className="group rounded-card border border-line bg-paper p-5">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-body font-bold text-ink [&::-webkit-details-marker]:hidden">
                {question}
                <ChevronDown
                  size={20}
                  aria-hidden="true"
                  className="shrink-0 text-text-muted transition-transform duration-150 ease-standard group-open:rotate-180"
                />
              </summary>
              <p className="mt-3 text-body-sm text-ink-soft">{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
