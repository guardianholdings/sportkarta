import {
  DOCUMENT_BODY_MAX,
  DOCUMENT_KINDS,
  DOCUMENT_REQUIRED_FOR,
  DOCUMENT_TITLE_MAX,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { listDocuments } from '@/lib/clubs/documents';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { formErrorText } from '@/lib/clubs/form-error';

import { saveDocumentAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * «Документи» (0055, wave G1): the club's waivers, rules and consents — who
 * must sign each, how many have, how many have not. The front of house reads
 * them; management writes them.
 */
export default async function ClubDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'members.view');
  const { rezultat } = await searchParams;
  const [t, messages, documents] = await Promise.all([
    getTranslations('ClubDocuments'),
    clubFormMessages(),
    listDocuments(actor, locale),
  ]);
  const canManage = actorCan(actor, 'documents.manage');
  const base = `/klub/${slug}/dokumenti`;
  const field = 'block text-body-sm font-semibold text-ink';
  const hint = 'mt-1 block text-caption font-normal text-text-muted';

  return (
    <main className="space-y-5">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      {rezultat && (
        <p
          role="status"
          className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
        >
          {rezultat === 'readOnly' ? messages.readOnly : formErrorText(messages, rezultat)}
        </p>
      )}

      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        {documents.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {documents.map((doc) => (
              <li key={doc.id} className="py-2.5">
                <Link
                  href={`${base}/${doc.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body-sm font-semibold text-ink">{doc.title}</span>
                    <span className="block text-caption text-text-muted">
                      {t(`kinds.${doc.kind}`)} · {t(`requiredFor.${doc.requiredFor}`)} ·{' '}
                      {t('version', { version: doc.version })}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
                    {doc.archived && <Badge tone="neutral">{t('archived')}</Badge>}
                    <span>{t('signedCount', { count: doc.signed })}</span>
                    {doc.missing > 0 && (
                      <Badge tone="warning">{t('missingCount', { count: doc.missing })}</Badge>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <details className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <summary className="cursor-pointer text-h4 font-bold text-ink">{t('new')}</summary>
          <form action={saveDocumentAction} className="mt-3 space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={field}>
                {t('form.kind')}
                <Select name="kind" defaultValue="waiver" className="mt-1">
                  {DOCUMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`kinds.${kind}`)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className={field}>
                {t('form.requiredFor')}
                <Select name="requiredFor" defaultValue="all" className="mt-1">
                  {DOCUMENT_REQUIRED_FOR.map((value) => (
                    <option key={value} value={value}>
                      {t(`requiredFor.${value}`)}
                    </option>
                  ))}
                </Select>
                <span className={hint}>{t('form.requiredForHint')}</span>
              </label>
            </div>
            <label className={field}>
              {t('form.titleBg')}
              <Input name="titleBg" required maxLength={DOCUMENT_TITLE_MAX} className="mt-1" />
            </label>
            <label className={field}>
              {t('form.titleEn')}
              <Input name="titleEn" maxLength={DOCUMENT_TITLE_MAX} className="mt-1" />
            </label>
            <label className={field}>
              {t('form.bodyBg')}
              <Textarea
                name="bodyBg"
                required
                rows={10}
                maxLength={DOCUMENT_BODY_MAX}
                className="mt-1"
              />
            </label>
            <label className={field}>
              {t('form.bodyEn')}
              <Textarea name="bodyEn" rows={6} maxLength={DOCUMENT_BODY_MAX} className="mt-1" />
              <span className={hint}>{t('form.bodyEnHint')}</span>
            </label>
            <p className="text-caption text-text-muted">{t('form.fixedHint')}</p>
            <Button type="submit">{t('form.create')}</Button>
          </form>
        </details>
      )}
    </main>
  );
}
