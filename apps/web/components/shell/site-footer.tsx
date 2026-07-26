'use client';

import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/navigation';

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
      <nav className="mx-auto flex max-w-2xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-6 text-caption">
        {/* Кампании lives here for the reason this footer exists: it was BURIED
            with zero inbound links anywhere in the product. A campaign STRIP
            cannot fix that on its own — it renders nothing the day the last
            campaign closes, which re-buries the page on a delay. This link is
            unconditional, so /kampanii stays reachable whether or not anything
            is currently running. */}
        <Link href="/kampanii" className="font-medium text-ink-soft hover:text-brand">
          {t('campaigns')}
        </Link>
        <Link href="/statistika" className="font-medium text-ink-soft hover:text-brand">
          {t('stats')}
        </Link>
        <Link href="/danni" className="font-medium text-ink-soft hover:text-brand">
          {t('openData')}
        </Link>
        <Link href="/partnyori" className="font-medium text-ink-soft hover:text-brand">
          {t('partners')}
        </Link>
        <Link href="/podkrepi" className="font-medium text-ink-soft hover:text-brand">
          {t('support')}
        </Link>
        <Link href="/privacy" className="font-medium text-ink-soft hover:text-brand">
          {t('privacy')}
        </Link>
        <span className="ml-auto text-text-muted">{t('attribution')}</span>
      </nav>
    </footer>
  );
}
