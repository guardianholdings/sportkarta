'use client';

import { useTranslations } from 'next-intl';

import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { PopsMark } from '@/components/shell/pops-mark';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * 44px tap target on a 20px line: the links are `text-body-sm`, so their boxes
 * would be under half the touch floor in a column where they stack — `min-h-11`
 * grows the hit area without changing the type or the column's density.
 */
const LINK = 'inline-flex min-h-11 items-center font-medium text-ink-soft hover:text-brand';

type FooterHref =
  | '/karta'
  | '/igri'
  | '/klasirane'
  | '/kampanii'
  | '/statistika'
  | '/za-klubove'
  | '/klubove'
  | '/klubove/zayavka'
  | '/danni'
  | '/danni/litsenz'
  | '/partnyori'
  | '/podkrepi'
  | '/kontakt'
  | '/privacy'
  | '/usloviya'
  | '/signal';

type LinkKey =
  | 'map'
  | 'sessions'
  | 'leaderboards'
  | 'campaigns'
  | 'stats'
  | 'clubsLanding'
  | 'clubsDirectory'
  | 'clubsApply'
  | 'openData'
  | 'dataLicense'
  | 'partners'
  | 'support'
  | 'contact'
  | 'privacy'
  | 'terms'
  | 'notice';

interface Column {
  key: 'platform' | 'clubs' | 'data' | 'org';
  links: readonly [FooterHref, LinkKey][];
}

const PLATFORM: Column = {
  key: 'platform',
  links: [
    ['/karta', 'map'],
    ['/igri', 'sessions'],
    ['/klasirane', 'leaderboards'],
    // Кампании lives here for the reason this footer exists: it was BURIED with
    // zero inbound links anywhere in the product. A campaign STRIP cannot fix
    // that on its own — it renders nothing the day the last campaign closes,
    // which re-buries the page on a delay. This link is unconditional, so
    // /kampanii stays reachable whether or not anything is currently running.
    ['/kampanii', 'campaigns'],
    ['/statistika', 'stats'],
  ],
};
const CLUBS: Column = {
  key: 'clubs',
  links: [
    ['/za-klubove', 'clubsLanding'],
    ['/klubove', 'clubsDirectory'],
    ['/klubove/zayavka', 'clubsApply'],
  ],
};
const DATA: Column = {
  key: 'data',
  links: [
    ['/danni', 'openData'],
    ['/danni/litsenz', 'dataLicense'],
  ],
};
// The legal set (pre-launch audit): who we are and how to reach us, the terms,
// and the notice form every hosting service owes (DSA Art. 16). On every page
// but the map, like the privacy link beside them.
const ORG: Column = {
  key: 'org',
  links: [
    ['/partnyori', 'partners'],
    ['/podkrepi', 'support'],
    ['/kontakt', 'contact'],
    ['/privacy', 'privacy'],
    ['/usloviya', 'terms'],
    ['/signal', 'notice'],
  ],
};

/**
 * Global footer — the persistent home for the transparency surfaces the audit
 * found BURIED (no in-app entry): statistics, open data, privacy — now four
 * columns, so a visitor who scrolled to the end of any page can reach every
 * public surface. Hidden on the full-screen map (`/karta`), which carries its
 * own bottom tab bar, and on a club's kiosk tablet. The front page (`/`) keeps
 * it: it is a page you scroll.
 *
 * `clubs` is whether the «Клубове» module is on; the layout passes it from
 * the server, so the column exists only while its links resolve.
 */
export function SiteFooter({ clubs = false }: { clubs?: boolean }) {
  const t = useTranslations('Footer');
  const pathname = usePathname();
  if (pathname === '/karta') return null;
  // A club's kiosk tablet (Stage 9) is a shared screen at the desk: it offers
  // no way off the page, so a member cannot wander the site on it.
  if (/^\/klub\/[^/]+\/kiosk\/?$/.test(pathname)) return null;

  const columns = clubs ? [PLATFORM, CLUBS, DATA, ORG] : [PLATFORM, DATA, ORG];

  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div
          className={cn(
            'grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3',
            clubs
              ? 'lg:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))]'
              : 'lg:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))]',
          )}
        >
          {/* The one brand moment visible on EVERY breakpoint: the mobile chrome
              (bottom tab bar) deliberately carries no mark, so without this a
              phone visitor never met „Усмивката" outside the browser chrome. */}
          <div className="col-span-2 flex flex-col gap-3 sm:col-span-3 lg:col-span-1">
            <Link
              href="/"
              className="inline-flex min-h-11 items-center gap-2.5 self-start text-ink"
            >
              <PopsMark size={28} className="text-accent" />
              <span className="font-display text-body-sm font-bold">{t('wordmark')}</span>
            </Link>
            <p className="max-w-xs text-body-sm text-ink-soft">{t('tagline')}</p>
            <LocaleSwitcher className="self-start text-body-sm" />
          </div>
          {columns.map((column) => (
            <nav key={column.key} aria-labelledby={`footer-${column.key}`}>
              <p
                id={`footer-${column.key}`}
                className="text-overline font-semibold uppercase tracking-wide text-text-muted"
              >
                {t(`columns.${column.key}`)}
              </p>
              <ul className="mt-2 flex flex-col text-body-sm">
                {column.links.map(([href, key]) => (
                  <li key={href}>
                    <Link href={href} className={LINK}>
                      {t(key)}
                    </Link>
                  </li>
                ))}
                {column.key === 'org' ? (
                  <li>
                    {/* A plain anchor, not <Link>: the consent script
                        (/consent.js) catches every click on a link ending in
                        #cookie-settings and reopens its card, so there is no
                        route to navigate to. */}
                    <a href="#cookie-settings" className={LINK}>
                      {t('cookieSettings')}
                    </a>
                  </li>
                ) : null}
              </ul>
            </nav>
          ))}
        </div>
        <p className="mt-8 border-t border-line pt-5 text-caption text-text-muted">
          {t('attribution')}
        </p>
      </div>
    </footer>
  );
}
