import { Flag } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

/**
 * «Сигнализирай за съдържание» — the way into /signal from a page that shows
 * somebody's content: a public passport (name, city), the boards that list
 * them, a session. It hands over the page's own path, which the form accepts
 * as a pre-fill only because it is a same-site path (lib/notice-input.ts).
 *
 * Quiet on purpose: a caption-sized link at the end of the page, not a button
 * next to a person's name. It is there for whoever needs it, not an invitation.
 */
export async function ReportContentLink({ path }: { path: string }) {
  const t = await getTranslations('Notice');
  return (
    <p className="text-caption text-text-muted">
      <Link
        href={{ pathname: '/signal', query: { url: path } }}
        className="inline-flex min-h-11 items-center gap-1.5 font-medium text-ink-soft hover:text-link-hover"
      >
        <Flag size={14} aria-hidden="true" />
        {t('reportLink')}
      </Link>
    </p>
  );
}
