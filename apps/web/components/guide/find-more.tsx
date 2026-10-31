import { ArrowRight, Landmark, Layers, Search, Building2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

const WAYS = [
  { key: 'search', icon: Search, href: null },
  { key: 'cities', icon: Building2, href: '/igrishta/sofia' },
  { key: 'municipality', icon: Landmark, href: '/obshtina/sofia' },
  { key: 'layers', icon: Layers, href: null },
] as const;

/** «Намерете», after the recording: the other ways in, and the map itself. */
export async function FindMore() {
  const t = await getTranslations('Home.guide.find');
  return (
    <div className="mt-10">
      <h3 className="text-h4 font-extrabold tracking-tight text-ink">{t('moreTitle')}</h3>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {WAYS.map(({ key, icon: Icon, href }) => (
          <li key={key} className="flex gap-3 rounded-card border border-line bg-surface p-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand-active">
              <Icon size={19} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-body font-bold text-ink">{t(`${key}.title`)}</span>
              <span className="mt-0.5 block text-body-sm text-ink-soft">{t(`${key}.body`)}</span>
              {href && (
                <Link
                  href={href}
                  className="mt-1.5 inline-flex items-center gap-1 text-body-sm font-semibold text-link hover:text-link-hover"
                >
                  {t(`${key}.link`)}
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <Link href="/karta" className={buttonVariants({ variant: 'primary' })}>
          {t('cta')}
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
