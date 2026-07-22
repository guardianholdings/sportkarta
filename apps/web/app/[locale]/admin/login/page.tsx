import { redirect } from '@/i18n/navigation';

export const metadata = { robots: { index: false, follow: false } };

/**
 * The Stage 1 shared-token login is gone (better-auth replaced it). Admins sign
 * in through the same email-OTP flow as everyone else; this route survives only
 * so existing bookmarks land somewhere useful.
 */
export default async function AdminLoginRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: { pathname: '/vhod', query: { next: '/admin' } }, locale });
}
