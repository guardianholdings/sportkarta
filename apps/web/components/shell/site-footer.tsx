'use client';

import { useTranslations } from 'next-intl';

import { PopsMark } from '@/components/shell/pops-mark';
import { Link, usePathname } from '@/i18n/navigation';

/**
 * 44px tap target on a 20px line: the links are `text-caption`, so their boxes
 * were 20px tall — under half the touch floor, in a row where six of them sit
 * side by side and a mis-tap lands on a neighbour. `min-h-11` grows the hit area
 * without changing the type or the row's visual density.
 */
const LINK = 'inline-flex min-h-11 items-center font-medium text-ink-soft hover:text-brand';

/**
 * Global footer — the persistent home for the transparency surfaces the audit
 * found BURIED (no in-app entry): statistics, open data, privacy. Hidden on the
 * full-screen map (`/`), which carries its own bottom tab bar.
 */
export function SiteFooter() {
  const t = useTranslations('Footer');
  const pathname = usePathname();
  if (pathname === '/') return null;

  return (
    <footer className="border-t border-line bg-surface">
      {/* The one brand moment visible on EVERY breakpoint: the mobile chrome
          (bottom tab bar) deliberately carries no mark, so without this a
          phone visitor never met „Усмивката" outside the browser chrome. */}
      <div className="mx-auto max-w-2xl px-4 pt-6">
        <Link href="/" className="inline-flex min-h-11 items-center gap-2.5 text-ink">
          <PopsMark size={28} className="text-accent" />
          <span className="font-display text-body-sm font-bold">{t('wordmark')}</span>
        </Link>
      </div>
      <nav className="mx-auto flex max-w-2xl flex-wrap items-center gap-x-5 gap-y-2 px-4 pb-6 pt-2 text-caption">
        {/* Кампании lives here for the reason this footer exists: it was BURIED
            with zero inbound links anywhere in the product. A campaign STRIP
            cannot fix that on its own — it renders nothing the day the last
            campaign closes, which re-buries the page on a delay. This link is
            unconditional, so /kampanii stays reachable whether or not anything
            is currently running. */}
        <Link href="/kampanii" className={LINK}>
          {t('campaigns')}
        </Link>
        <Link href="/statistika" className={LINK}>
          {t('stats')}
        </Link>
        <Link href="/danni" className={LINK}>
          {t('openData')}
        </Link>
        <Link href="/partnyori" className={LINK}>
          {t('partners')}
        </Link>
        <Link href="/podkrepi" className={LINK}>
          {t('support')}
        </Link>
        <Link href="/privacy" className={LINK}>
          {t('privacy')}
        </Link>
        <span className="ml-auto text-text-muted">{t('attribution')}</span>
      </nav>
    </footer>
  );
}
