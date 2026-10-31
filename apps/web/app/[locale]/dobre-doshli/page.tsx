import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import type { ProfileError } from '@/lib/profile';
import { signInDestination } from '@/lib/sign-in-destination';

import { welcomeAction } from './actions';

/**
 * First-run name step (UX audit, «New account»). A new account used to land on
 * /profil with an empty REQUIRED name and no word of welcome — and a blank
 * name then showed on rosters, boards and mails. The code step sends a
 * nameless account here (vhod/actions.ts); one field, «Продължи», and the
 * member is on the page they came for. A named account never sees it: the
 * page passes straight through.
 *
 * No AppShell: a first-run screen between sign-in and the destination, where
 * the tab bar would only be a way to leave with no name.
 */

export const dynamic = 'force-dynamic';

const ERRORS: readonly ProfileError[] = [
  'display_name_required',
  'display_name_too_long',
  'home_city_too_long',
];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Welcome' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function WelcomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requireUser();
  const sp = await searchParams;
  const next = signInDestination(sp.next);
  if (user.displayName.trim() !== '') redirect({ href: next, locale });

  const t = await getTranslations('Welcome');
  const error = ERRORS.find((code) => code === sp.greshka) ?? null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      <p className="mt-2 text-body text-ink-soft">{t('intro')}</p>
      <form action={welcomeAction} className="mt-6 flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="locale" value={locale} />
        <label className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-soft">{t('nameLabel')}</span>
          <Input
            type="text"
            name="displayName"
            required
            maxLength={60}
            autoComplete="nickname"
            autoFocus
            aria-invalid={error === 'display_name_required' || error === 'display_name_too_long'}
            aria-describedby="welcome-name-hint"
          />
          <span id="welcome-name-hint" className="text-caption text-text-muted">
            {t('nameHint')}
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-soft">{t('cityLabel')}</span>
          <Input type="text" name="homeCity" maxLength={80} autoComplete="address-level2" />
        </label>
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {t(`errors.${error}`)}
          </p>
        )}
        <Button type="submit" variant="accent" block>
          {t('submit')}
        </Button>
      </form>
    </main>
  );
}
