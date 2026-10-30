import {
  DOCUMENT_BODY_MAX,
  DOCUMENT_KINDS,
  DOCUMENT_REQUIRED_FOR,
  DOCUMENT_TITLE_MAX,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { documentForStaff } from '@/lib/clubs/documents';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { formatDateTime } from '@/lib/format';
import { formErrorText } from '@/lib/clubs/form-error';

import { archiveDocumentAction, publishVersionAction, saveDocumentAction } from '../actions';

export const dynamic = 'force-dynamic';

const GOOD = new Set(['created', 'saved', 'versioned', 'archived', 'restored']);

/**
 * One document (0055): its text in every version (the newest first, each with
 * the hash the database computed), who signed which version and how, and who
 * it still asks. Management edits the heading, publishes a new version and
 * archives it; the text itself is never edited.
 */
export default async function ClubDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string; documentId: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, documentId } = await params;
  setRequestLocale(locale);
  if (!isUuid(documentId)) notFound();
  const { actor } = await requireClubStaff(slug, 'members.view');
  const [t, messages, doc] = await Promise.all([
    getTranslations('ClubDocuments'),
    clubFormMessages(),
    documentForStaff(actor, documentId, locale),
  ]);
  if (!doc) notFound();
  const { rezultat } = await searchParams;
  const good = rezultat !== undefined && GOOD.has(rezultat);
  const canManage = actorCan(actor, 'documents.manage');
  const latest = doc.versions[0];
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const hint = 'mt-1 block text-caption font-normal text-text-muted';
  const base = `/klub/${slug}`;

  return (
    <main className="space-y-5">
      <div>
        <Link
          href={`${base}/dokumenti`}
          className="text-body-sm font-semibold text-link hover:text-link-hover"
        >
          ← {t('back')}
        </Link>
        <h1 className="mt-1 text-h2 font-extrabold tracking-tight text-ink">{doc.title}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-body-sm text-ink-soft">
          {t(`kinds.${doc.kind}`)} · {t(`requiredFor.${doc.requiredFor}`)} ·{' '}
          {t('version', { version: doc.version })}
          {doc.archived && <Badge tone="neutral">{t('archived')}</Badge>}
        </p>
      </div>

      {rezultat && (
        <p
          role="status"
          className={
            good
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {good
            ? t(`outcome.${rezultat}`)
            : rezultat === 'readOnly'
              ? messages.readOnly
              : formErrorText(messages, rezultat)}
        </p>
      )}

      {latest && (
        <section className={section} aria-labelledby="text-h">
          <h2 id="text-h" className="text-h4 font-bold text-ink">
            {t('text', { version: latest.version })}
          </h2>
          <div className="whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-3 text-body-sm text-ink">
            {latest.bodyBg}
          </div>
          {latest.bodyEn && (
            <details>
              <summary className="cursor-pointer text-caption font-semibold text-link">
                {t('english')}
              </summary>
              <div className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-3 text-body-sm text-ink">
                {latest.bodyEn}
              </div>
            </details>
          )}
          <p className="break-all text-caption text-text-muted">
            {t('published', {
              when: formatDateTime(latest.publishedAt, locale),
              who: latest.publishedByName ?? t('formerStaff'),
            })}{' '}
            · {t('hashLabel')} <span className="font-mono">{latest.sha256}</span>
          </p>
          {doc.versions.length > 1 && (
            <details>
              <summary className="cursor-pointer text-caption font-semibold text-link">
                {t('earlier', { count: doc.versions.length - 1 })}
              </summary>
              <ul className="mt-2 space-y-3">
                {doc.versions.slice(1).map((version) => (
                  <li key={version.id} className="space-y-1">
                    <p className="text-caption font-semibold text-ink">
                      {t('text', { version: version.version })} ·{' '}
                      {formatDateTime(version.publishedAt, locale)}
                      {!version.requiresResign && ` · ${t('noResign')}`}
                    </p>
                    <p className="text-caption text-ink">{version.titleBg}</p>
                    <div className="whitespace-pre-wrap rounded-md border border-line p-2 text-caption text-ink-soft">
                      {version.bodyBg}
                    </div>
                    {version.bodyEn && (
                      <div className="whitespace-pre-wrap rounded-md border border-line p-2 text-caption text-ink-soft">
                        {version.bodyEn}
                      </div>
                    )}
                    <p className="break-all font-mono text-caption text-text-muted">
                      {version.sha256}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={section} aria-labelledby="signed-h">
          <h2 id="signed-h" className="text-h4 font-bold text-ink">
            {t('signatures', { count: doc.signatures.length })}
          </h2>
          {doc.signatures.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('noSignatures')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {doc.signatures.map((signature) => (
                <li key={signature.id} className="flex flex-wrap items-baseline gap-2 py-2">
                  <span className="min-w-0 flex-1 text-body-sm">
                    <Link
                      href={`${base}/chlenove/${signature.memberId}`}
                      className="font-semibold text-link hover:text-link-hover"
                    >
                      {signature.memberName}
                    </Link>
                    <span className="block text-caption text-text-muted">
                      {t('signedBy', {
                        name: signature.signerName,
                        kind: t(`signerKinds.${signature.signerKind}`),
                      })}{' '}
                      · {t(`methods.${signature.method}`)}
                      {signature.witnessName
                        ? ` · ${t('witness', { name: signature.witnessName })}`
                        : ''}{' '}
                      · {t('versionShort', { version: signature.version })} ·{' '}
                      {formatDateTime(signature.signedAt, locale)}
                    </span>
                  </span>
                  <Link
                    href={`${base}/dokumenti/podpis/${signature.id}`}
                    className="text-caption font-semibold text-link hover:text-link-hover"
                  >
                    {t('print')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={section} aria-labelledby="missing-h">
          <h2 id="missing-h" className="text-h4 font-bold text-ink">
            {t('missingTitle', { count: doc.missing })}
          </h2>
          {doc.missingMembers.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('noneMissing')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {doc.missingMembers.map((member) => (
                <li key={member.id}>
                  <Link
                    href={`${base}/chlenove/${member.id}#documents-h`}
                    className="inline-flex min-h-11 items-center rounded-pill border border-line px-3 text-caption font-semibold text-link hover:bg-surface-2"
                  >
                    {member.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="text-caption text-text-muted">{t('missingHint')}</p>
        </section>
      </div>

      {canManage && !doc.archived && latest && (
        <details className={section}>
          <summary className="cursor-pointer text-h4 font-bold text-ink">{t('newVersion')}</summary>
          <form action={publishVersionAction} className="mt-3 space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="documentId" value={doc.id} />
            <label className={field}>
              {t('form.titleBg')}
              <Input
                name="titleBg"
                required
                maxLength={DOCUMENT_TITLE_MAX}
                defaultValue={latest.titleBg}
                className="mt-1"
              />
            </label>
            <label className={field}>
              {t('form.titleEn')}
              <Input
                name="titleEn"
                maxLength={DOCUMENT_TITLE_MAX}
                defaultValue={latest.titleEn ?? ''}
                className="mt-1"
              />
            </label>
            <label className={field}>
              {t('form.bodyBg')}
              <Textarea
                name="bodyBg"
                required
                rows={10}
                maxLength={DOCUMENT_BODY_MAX}
                defaultValue={latest.bodyBg}
                className="mt-1"
              />
            </label>
            <label className={field}>
              {t('form.bodyEn')}
              <Textarea
                name="bodyEn"
                rows={6}
                maxLength={DOCUMENT_BODY_MAX}
                defaultValue={latest.bodyEn ?? ''}
                className="mt-1"
              />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-body-sm text-ink">
              <input
                type="checkbox"
                name="requiresResign"
                defaultChecked
                className="size-4 accent-[var(--brand)]"
              />
              {t('form.requiresResign')}
            </label>
            <p className="text-caption text-text-muted">{t('form.requiresResignHint')}</p>
            <Button type="submit">{t('form.publish')}</Button>
          </form>
        </details>
      )}

      {canManage && (
        <details className={section}>
          <summary className="cursor-pointer text-h4 font-bold text-ink">{t('settings')}</summary>
          <form action={saveDocumentAction} className="mt-3 space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="documentId" value={doc.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={field}>
                {t('form.kind')}
                <Select name="kind" defaultValue={doc.kind} className="mt-1">
                  {DOCUMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`kinds.${kind}`)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className={field}>
                {t('form.requiredFor')}
                <Select name="requiredFor" defaultValue={doc.requiredFor} className="mt-1">
                  {DOCUMENT_REQUIRED_FOR.map((value) => (
                    <option key={value} value={value}>
                      {t(`requiredFor.${value}`)}
                    </option>
                  ))}
                </Select>
                <span className={hint}>{t('form.requiredForHint')}</span>
              </label>
            </div>
            <p className="text-caption text-text-muted">{t('form.renameHint')}</p>
            <Button type="submit" variant="secondary">
              {t('form.save')}
            </Button>
          </form>
          <form action={archiveDocumentAction} className="border-t border-line pt-3">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="documentId" value={doc.id} />
            <input type="hidden" name="archive" value={doc.archived ? '0' : '1'} />
            {doc.archived ? (
              <Button type="submit" variant="secondary">
                {t('restore')}
              </Button>
            ) : (
              <ConfirmButton
                message={t('archiveConfirm')}
                className="min-h-11 rounded-pill border border-line-strong px-4 text-body-sm font-semibold text-ink hover:bg-surface-2"
              >
                {t('archive')}
              </ConfirmButton>
            )}
          </form>
        </details>
      )}
    </main>
  );
}
