import { getTranslations } from 'next-intl/server';

import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { PopsMark } from '@/components/shell/pops-mark';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

/**
 * The slim top bar of the marketing pages (the front page and the clubs page)
 * — the one place the product has a sign-in call to action, and the brand
 * moment a phone visitor otherwise never gets (the bottom tab bar carries no
 * mark). It renders INSIDE the AppShell's content column, so on wide screens it
 * sits beside the nav rail rather than over it, and on phones the bottom bar
 * keeps its job: this bar never repeats a primary tab's affordance as a tab.
 *
 * Server component: it reads the `Marketing` namespace on the server, so
 * nothing new reaches the client catalogue (i18n/client-messages.ts). The one
 * client child is the locale switcher, which the footer already ships.
 */
export async function MarketingHeader({
  signedIn,
  clubs,
}: {
  signedIn: boolean;
  /** Whether the «Клубове» module is on (lib/clubs/access.ts). */
  clubs: boolean;
}) {
  const t = await getTranslations('Marketing');
  const links: { href: '/karta' | '/sesii' | '/danni' | '/klubove'; label: string }[] = [
    { href: '/karta', label: t('nav.map') },
    { href: '/sesii', label: t('nav.sessions') },
    { href: '/danni', label: t('nav.data') },
  ];
  if (clubs) links.push({ href: '/klubove', label: t('nav.clubs') });

  return (
    <header className="sk-marketing-header sticky top-0 z-30 border-b border-line">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          aria-label={t('brandLabel')}
          className="inline-flex min-h-11 items-center gap-2 text-ink"
        >
          <PopsMark size={28} className="text-accent" />
          <span className="font-display text-body font-extrabold tracking-tight">
            {t('wordmark')}
          </span>
        </Link>
        <nav aria-label={t('navLabel')} className="hidden items-center gap-1 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-11 items-center rounded-pill px-3 text-body-sm font-semibold text-ink-soft hover:bg-surface-2 hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <LocaleSwitcher className="hidden text-body-sm md:inline-flex" />
          <Link
            href={signedIn ? '/profil' : '/vhod'}
            className={buttonVariants({ variant: signedIn ? 'secondary' : 'primary', size: 'sm' })}
          >
            {signedIn ? t('profile') : t('signIn')}
          </Link>
        </div>
      </div>
    </header>
  );
}
