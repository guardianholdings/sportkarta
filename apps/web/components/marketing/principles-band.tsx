import { ArrowRight, Database, EyeOff, HeartHandshake, UserCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import { Reveal } from '@/components/motion/reveal';
import { Link } from '@/i18n/navigation';

const PRINCIPLES = [
  { key: 'ngo', href: '/podkrepi', icon: HeartHandshake },
  { key: 'tracking', href: '/privacy', icon: EyeOff },
  { key: 'openData', href: '/danni', icon: Database },
  // Export and erasure live in the profile; a stranger is sent to the policy
  // that describes them rather than to a sign-in wall.
  { key: 'yourData', href: '/profil', icon: UserCheck },
] as const;

/**
 * «Защо POPS» — the four things a visitor cannot see unless told: an
 * association rather than a company, no trackers (and so no consent banner),
 * open data under ODbL, the member's data in the member's hands. Each tile is
 * a link to the page that proves it.
 */
export async function PrinciplesBand({ signedIn }: { signedIn: boolean }) {
  const t = await getTranslations('Home.principles');
  return (
    <section
      aria-labelledby="home-principles"
      className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20"
    >
      <SectionHead id="home-principles" overline={t('overline')} title={t('title')} />
      <Reveal>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PRINCIPLES.map((item) => (
            <li key={item.key} data-reveal>
              <Link
                href={item.key === 'yourData' && !signedIn ? '/privacy' : item.href}
                className="group flex h-full flex-col gap-3 rounded-card border border-line bg-surface p-5 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand">
                  <item.icon size={22} aria-hidden="true" />
                </span>
                <span className="text-body font-bold text-ink group-hover:text-brand">
                  {t(`${item.key}.title`)}
                </span>
                <span className="text-body-sm text-ink-soft">{t(`${item.key}.body`)}</span>
                <span className="mt-auto inline-flex items-center gap-1 pt-1 text-body-sm font-semibold text-link group-hover:text-link-hover">
                  {t(`${item.key}.link`)}
                  <ArrowRight size={16} aria-hidden="true" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
