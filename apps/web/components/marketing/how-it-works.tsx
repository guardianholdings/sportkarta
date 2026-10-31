import { Award, CalendarDays, MapPin } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

const STEPS = [
  { key: 'find', href: '/karta', icon: MapPin },
  { key: 'join', href: '/sesii', icon: CalendarDays },
  { key: 'collect', href: '/pasport', icon: Award },
] as const;

/**
 * «Как работи» — the three acts of the free product, each one a link: find a
 * place, join a тренировка, collect the passport. Deliberately nothing about
 * clubs here: the module is mentioned in exactly one section of the page.
 */
export async function HowItWorks() {
  const t = await getTranslations('Home.how');
  return (
    <section
      aria-labelledby="home-how"
      className="mx-auto max-w-6xl px-4 pb-6 pt-2 sm:px-6 lg:px-8 lg:pb-10"
    >
      <h2 id="home-how" className="sr-only">
        {t('title')}
      </h2>
      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.key}>
            <Link
              href={step.href}
              className="group flex h-full items-start gap-4 rounded-card border border-line bg-surface p-5 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
            >
              <span className="relative grid size-12 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand">
                <step.icon size={22} aria-hidden="true" />
                <span
                  aria-hidden="true"
                  className="absolute -left-1 -top-1 grid size-5 place-items-center rounded-full bg-accent font-mono text-overline font-bold text-on-accent"
                >
                  {index + 1}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block text-body font-bold text-ink group-hover:text-brand">
                  {t(`${step.key}.title`)}
                </span>
                <span className="mt-0.5 block text-body-sm text-ink-soft">
                  {t(`${step.key}.body`)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
