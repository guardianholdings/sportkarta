import { SIGNER_NAME_MAX } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { portalDocuments } from '@/lib/clubs/documents';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { portalView } from '@/lib/clubs/portal';
import { formatDateTime } from '@/lib/format';
import { formErrorText } from '@/lib/clubs/form-error';

import { signDocumentAction } from './actions';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubDocuments' });
  return { title: t('portal.title'), robots: { index: false, follow: false } };
}

/**
 * «Документи» in the portal (0055): the club's documents for the account's
 * own record and its children's, each with its full text, and a signature —
 * the name the signer types and a tick. Every record shown is one the account
 * may sign: its own (a minor's too, as the client) or a child's, as the
 * guardian (0055, operator decision 2026-10-30).
 */
export default async function PortalDocumentsPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const user = await requireUser();
  const view = await portalView(user.id, slug, locale);
  if (!view || view.link?.status !== 'active') notFound();
  const { rezultat } = await searchParams;
  const [t, messages, documents] = await Promise.all([
    getTranslations('ClubDocuments'),
    clubFormMessages(),
    portalDocuments(user.id, view.club.id, locale),
  ]);
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const records = [...new Map(documents.map((d) => [d.memberId, d.memberName])).entries()];

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-5 p-4">
        <header className="space-y-1 border-b border-line pb-3">
          <Link
            href={`/klub/${slug}/az`}
            className="text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {view.club.name}
          </Link>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('portal.title')}</h1>
          <p className="text-body-sm text-ink-soft">{t('portal.intro')}</p>
        </header>

        {rezultat && (
          <p
            role="status"
            className={
              rezultat === 'signed'
                ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
                : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
            }
          >
            {rezultat === 'signed' ? t('portal.signed') : formErrorText(messages, rezultat)}
          </p>
        )}

        {documents.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('portal.empty')}</p>
        ) : (
          records.map(([memberId, memberName]) => (
            <section key={memberId} className={section} aria-label={memberName}>
              <h2 className="text-h4 font-bold text-ink">{memberName}</h2>
              <ul className="space-y-4">
                {documents
                  .filter((doc) => doc.memberId === memberId)
                  .map((doc) => (
                    <li key={doc.documentId} className="space-y-2">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-body font-semibold text-ink">
                          {doc.title}
                        </span>
                        {doc.missing ? (
                          <Badge tone="warning">{t('portal.toSign')}</Badge>
                        ) : doc.signedAt ? (
                          <Badge tone="success">{t('signedBadge')}</Badge>
                        ) : null}
                      </p>
                      {doc.signedAt && (
                        <p className="text-caption text-text-muted">
                          {t('portal.signedAt', { when: formatDateTime(doc.signedAt, locale) })}
                        </p>
                      )}
                      <details open={doc.missing}>
                        <summary className="cursor-pointer text-caption font-semibold text-link">
                          {t('portal.read', { version: doc.version })}
                        </summary>
                        <div className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-3 text-body-sm text-ink">
                          {doc.body}
                        </div>
                      </details>
                      {(doc.missing || !doc.signedAt) && (
                        <form action={signDocumentAction} className="space-y-2">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="memberId" value={doc.memberId} />
                          <input type="hidden" name="documentId" value={doc.documentId} />
                          <input type="hidden" name="versionId" value={doc.versionId} />
                          <label className="block text-body-sm font-semibold text-ink">
                            {doc.own ? t('portal.yourName') : t('portal.guardianName')}
                            <Input
                              name="signerName"
                              required
                              maxLength={SIGNER_NAME_MAX}
                              autoComplete="name"
                              className="mt-1"
                            />
                          </label>
                          <label className="flex min-h-11 items-start gap-2 text-body-sm text-ink">
                            <input
                              type="checkbox"
                              name="accept"
                              required
                              className="mt-1 size-4 accent-[var(--brand)]"
                            />
                            {doc.own
                              ? t('portal.accept')
                              : t('portal.acceptGuardian', { name: doc.memberName })}
                          </label>
                          <Button type="submit">{t('portal.sign')}</Button>
                        </form>
                      )}
                    </li>
                  ))}
              </ul>
            </section>
          ))
        )}
      </main>
    </AppShell>
  );
}
