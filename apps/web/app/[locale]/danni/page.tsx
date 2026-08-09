import { dumpManifest, getDb, latestDumpVersion } from '@sportkarta/db';
import {
  EXPORT_DATASETS,
  OPEN_DATA_API_VERSION,
  OPEN_DATA_LICENSE,
  type ExportDataset,
} from '@sportkarta/lib/opendata';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { OPEN_DATA_LIMITS } from '@/lib/opendata/limits';
import { buildAlternates, siteUrl } from '@/lib/seo';
import { AppShell } from '@/components/shell/app-shell';

/**
 * The open-data portal (docs/ROADMAP.md §8, Stage 6.1).
 *
 * THE FIELD TABLES RENDER FROM THE CATALOGUE. Every dataset, every field, every
 * format on this page is read from lib/src/opendata/schema.ts — the same array
 * the API serves from, the dump job writes from and the PII denylist scans. So
 * a field cannot be exported undocumented: adding one to the catalogue puts it
 * on this page, and there is no other way to add one. The alternative — a
 * hand-written documentation page — is a page that is accurate on the day it is
 * written and quietly wrong within two releases, which for an API somebody's
 * dashboard depends on is worse than no documentation at all.
 *
 * The dataset titles and field descriptions come from i18n keys the catalogue
 * NAMES, so the same guarantee covers both languages: a field with no
 * description key does not render, and apps/web/tests/opendata.test.ts asserts
 * every key in the catalogue resolves in bg and en.
 */

type PageParams = Promise<{ locale: string }>;

// The dumps section reads the live manifest.
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'OpenData' });
  return {
    title: t('title'),
    description: t('intro'),
    alternates: buildAlternates('/danni', locale),
  };
}

function apiUrl(dataset: ExportDataset): string {
  return `${siteUrl()}/api/opendata/${OPEN_DATA_API_VERSION}/${dataset.id}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function OpenDataPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('OpenData');

  const db = getDb();
  // A portal that 500s because no dump has run yet would be a bad first
  // impression for exactly the audience this page exists for.
  const version = await latestDumpVersion(db).catch(() => null);
  const manifest = version ? await dumpManifest(db, version).catch(() => null) : null;

  return (
    <AppShell>
      <main className="mx-auto max-w-3xl space-y-10 p-4">
        <div className="space-y-3">
          <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
            {t('back')}
          </Link>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="text-ink-soft">{t('intro')}</p>
          <p className="rounded-md border border-info-border bg-info-bg p-3 text-body-sm text-info">
            {t('attributionNotice')}{' '}
            <Link href="/danni/litsenz" className="font-medium text-link hover:text-link-hover">
              {t('licenseLink')}
            </Link>
          </p>
        </div>

        <section className="space-y-3">
          <h2 className="text-h4 font-bold text-ink">{t('apiTitle')}</h2>
          <p className="text-ink-soft">{t('apiIntro')}</p>
          <p className="text-body-sm text-ink-soft">
            {t('apiBaseLabel')}:{' '}
            <code className="rounded-sm bg-paper-sunk px-1">
              {siteUrl()}/api/opendata/{OPEN_DATA_API_VERSION}
            </code>
          </p>

          <div className="space-y-1">
            <h3 className="text-body-sm font-semibold text-ink">{t('apiAnonymousTitle')}</h3>
            <p className="text-body-sm text-ink-soft">{t('apiAnonymousBody')}</p>
          </div>
          <div className="space-y-1">
            <h3 className="text-body-sm font-semibold text-ink">{t('apiAuthTitle')}</h3>
            <p className="text-body-sm text-ink-soft">{t('apiAuthBody')}</p>
            <Link
              href="/danni/klyuchove"
              className="text-body-sm font-medium text-link hover:text-link-hover"
            >
              {t('keysLink')}
            </Link>
          </div>
          <div className="space-y-1">
            <h3 className="text-body-sm font-semibold text-ink">{t('apiLimitsTitle')}</h3>
            <p className="text-body-sm text-ink-soft">
              {t('apiLimitsBody', {
                anon: OPEN_DATA_LIMITS.anonPerMinute,
                keyed: OPEN_DATA_LIMITS.keyedPerMinute,
              })}
            </p>
            <p className="text-body-sm font-medium text-ink">{t('apiDumpsUnmetered')}</p>
          </div>
          <div className="space-y-1">
            <h3 className="text-body-sm font-semibold text-ink">{t('apiParamsTitle')}</h3>
            <ul className="list-disc space-y-1 pl-5 text-body-sm text-ink-soft">
              <li>{t('apiParamFormat')}</li>
              <li>{t('apiParamLimit')}</li>
            </ul>
          </div>
          <div className="space-y-1">
            <h3 className="text-body-sm font-semibold text-ink">{t('apiExampleTitle')}</h3>
            {/* Shell, not UI text — deliberately not translated. */}
            <pre className="overflow-x-auto rounded-md bg-paper-sunk p-3 font-mono text-caption text-ink">
              {`curl -H "Authorization: Bearer skbg_…" \\\n  "${siteUrl()}/api/opendata/${OPEN_DATA_API_VERSION}/facilities?format=csv"`}
            </pre>
          </div>
        </section>

        <section className="space-y-6">
          <h2 className="text-h4 font-bold text-ink">{t('datasetsTitle')}</h2>
          {EXPORT_DATASETS.map((dataset) => (
            <article
              key={dataset.id}
              className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm"
            >
              <h3 className="text-body font-bold">{t(`datasets.${dataset.titleKey}`)}</h3>
              <p className="text-body-sm text-ink-soft">
                {t(`datasets.${dataset.descriptionKey}`)}
              </p>
              <p className="text-caption text-ink-soft">
                <code className="rounded-sm bg-paper-sunk px-1">{apiUrl(dataset)}</code>
              </p>
              <p className="text-caption text-ink-soft">
                {t('apiFormatLabel')}: {dataset.formats.join(', ')}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-caption">
                  <thead className="text-ink-soft">
                    <tr>
                      <th className="py-1 pr-3 font-medium">{t('fieldName')}</th>
                      <th className="py-1 pr-3 font-medium">{t('fieldType')}</th>
                      <th className="py-1 font-medium">{t('fieldDescription')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataset.fields.map((field) => (
                      <tr key={field.name} className="border-t border-line align-top">
                        <td className="py-1 pr-3">
                          <code>{field.name}</code>
                        </td>
                        <td className="py-1 pr-3 text-ink-soft">{field.type}</td>
                        <td className="py-1 text-ink-soft">
                          {t(`fields.${field.descriptionKey}`)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </section>

        <section className="space-y-3">
          <h2 className="text-h4 font-bold text-ink">{t('dumpsTitle')}</h2>
          <p className="text-ink-soft">{t('dumpsIntro')}</p>
          <p className="text-body-sm text-ink-soft">
            {t('dumpsRetention', { keep: Number(process.env.OPENDATA_DUMP_RETENTION ?? 30) })}
          </p>

          {manifest && manifest.files.length > 0 ? (
            <div className="space-y-2">
              <p className="text-body-sm font-medium">
                {t('dumpsLatest')}: <code>{manifest.version}</code>
              </p>
              <ul className="space-y-2 text-body-sm">
                {manifest.files.map((file) => (
                  <li
                    key={`${file.dataset}.${file.format}`}
                    className="flex flex-wrap items-baseline gap-x-3 border-t border-line pt-2"
                  >
                    <a
                      className="font-medium text-link hover:text-link-hover"
                      href={`/api/opendata/${OPEN_DATA_API_VERSION}/dumps/${file.version}/${file.dataset}.${file.format}`}
                    >
                      {file.dataset}.{file.format}
                    </a>
                    <span className="text-ink-soft">
                      {formatBytes(file.bytes)} · {file.rowCount} {t('dumpsRows')}
                    </span>
                    <code className="text-caption text-text-muted">
                      {t('dumpsChecksum')} {file.sha256.slice(0, 16)}…
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-body-sm text-ink-soft">{t('dumpsNone')}</p>
          )}

          <p className="text-body-sm">
            <a
              className="font-medium text-link hover:text-link-hover"
              href={`/api/opendata/${OPEN_DATA_API_VERSION}/dumps`}
            >
              {t('dumpsManifest')}
            </a>
          </p>
        </section>

        <footer className="border-t border-line pt-4 text-body-sm text-ink-soft">
          {OPEN_DATA_LICENSE.attribution}
        </footer>
      </main>
    </AppShell>
  );
}
