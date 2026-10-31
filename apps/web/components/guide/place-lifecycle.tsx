import { BadgeCheck, CircleHelp, Map as MapIcon, MapPinPlus, Users } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Reveal } from '@/components/motion/reveal';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

const STAGES = [
  { key: 's1', icon: MapPinPlus, tone: 'accent' },
  { key: 's2', icon: MapIcon, tone: 'sky' },
  { key: 's3', icon: Users, tone: 'sky' },
  { key: 's4', icon: BadgeCheck, tone: 'brand' },
] as const;

const TONE = {
  accent: 'border-accent bg-accent-subtle text-accent-active',
  sky: 'border-sky-500 bg-sky-100 text-sky-700',
  brand: 'border-brand bg-brand-subtle text-brand-active',
} as const;

/**
 * «Пътят на едно ново място»: added → on the map at once, awaiting
 * verification → confirmed on site by somebody else → verified; and the
 * branch for a place that is gone, which a moderator decides. Every stage is
 * what lib/contributions does (add-facility.ts, verify-facility.ts), not a
 * promise. The live count of places waiting closes it.
 */
export async function PlaceLifecycle({ waiting }: { waiting: number | null }) {
  const t = await getTranslations('Home.guide.contribute.lifecycle');
  return (
    <div className="mt-10 rounded-card border border-line bg-surface p-5 shadow-xs sm:p-6">
      <h3 className="text-h4 font-extrabold tracking-tight text-ink">{t('title')}</h3>
      <Reveal stagger={0.12}>
        <ol className="sk-lifecycle mt-5 grid gap-4 sm:grid-cols-4 sm:gap-3">
          {STAGES.map(({ key, icon: Icon, tone }, index) => (
            <li key={key} data-reveal className="relative flex gap-3 sm:flex-col">
              <span
                className={cn(
                  'sk-lifecycle__node grid size-11 shrink-0 place-items-center rounded-full border-2',
                  TONE[tone],
                )}
              >
                <Icon size={20} aria-hidden="true" />
                <span className="sr-only">{index + 1}.</span>
              </span>
              <span className="min-w-0">
                <span className="block text-body-sm font-bold text-ink">{t(`${key}.title`)}</span>
                <span className="mt-0.5 block text-caption text-ink-soft">{t(`${key}.body`)}</span>
              </span>
            </li>
          ))}
        </ol>
      </Reveal>
      <div className="mt-5 flex gap-3 rounded-lg border border-dashed border-line-strong bg-paper p-4">
        <CircleHelp size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-soft" />
        <p className="text-body-sm text-ink-soft">
          <span className="font-bold text-ink">{t('gone.title')}</span> {t('gone.body')}
        </p>
      </div>
      {waiting !== null && waiting > 0 && (
        <p className="mt-4 flex items-center gap-2.5 text-body-sm font-semibold text-ink">
          <span aria-hidden="true" className="sk-live-dot" />
          <Link href="/karta?blizo=1" className="text-link hover:text-link-hover">
            {t('waiting', { count: waiting })}
          </Link>
        </p>
      )}
    </div>
  );
}
