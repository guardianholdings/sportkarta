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
    <main className="mx-auto max-w-3xl space-y-10 p-4">
      <div className="space-y-3">
        <Link href="/" className="text-sm underline">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-neutral-700">{t('intro')}</p>
        <p className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">
          {t('attributionNotice')}{' '}
          <Link href="/danni/litsenz" className="underline">
            {t('licenseLink')}
          </Link>
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('apiTitle')}</h2>
        <p className="text-neutral-700">{t('apiIntro')}</p>
        <p className="text-sm text-neutral-600">
          {t('apiBaseLabel')}:{' '}
          <code className="rounded bg-neutral-100 px-1">
            {siteUrl()}/api/opendata/{OPEN_DATA_API_VERSION}
          </code>
        </p>

        <div className="space-y-1">
          <h3 className="font-medium">{t('apiAnonymousTitle')}</h3>
          <p className="text-sm text-neutral-700">{t('apiAnonymousBody')}</p>
        </div>
        <div className="space-y-1">
          <h3 className="font-medium">{t('apiAuthTitle')}</h3>
          <p className="text-sm text-neutral-700">{t('apiAuthBody')}</p>
          <Link href="/danni/klyuchove" className="text-sm text-teal-700 underline">
            {t('keysLink')}
          </Link>
        </div>
        <div className="space-y-1">
          <h3 className="font-medium">{t('apiLimitsTitle')}</h3>
          <p className="text-sm text-neutral-700">
            {t('apiLimitsBody', {
              anon: OPEN_DATA_LIMITS.anonPerMinute,
              keyed: OPEN_DATA_LIMITS.keyedPerMinute,
            })}
          </p>
          <p className="text-sm font-medium text-neutral-800">{t('apiDumpsUnmetered')}</p>
        </div>
        <div className="space-y-1">
          <h3 className="font-medium">{t('apiParamsTitle')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700">
            <li>{t('apiParamFormat')}</li>
            <li>{t('apiParamLimit')}</li>
          </ul>
        </div>
        <div className="space-y-1">
          <h3 className="font-medium">{t('apiExampleTitle')}</h3>
          {/* Shell, not UI text — deliberately not translated. */}
          <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
            {`curl -H "Authorization: Bearer skbg_…" \\\n  "${siteUrl()}/api/opendata/${OPEN_DATA_API_VERSION}/facilities?format=csv"`}
          </pre>
        </div>
      </section>

      <section className="space-y-6">
        <h2 className="text-lg font-semibold">{t('datasetsTitle')}</h2>
        {EXPORT_DATASETS.map((dataset) => (
          <article key={dataset.id} className="space-y-2 rounded border border-neutral-200 p-4">
            <h3 className="font-semibold">{t(`datasets.${dataset.titleKey}`)}</h3>
            <p className="text-sm text-neutral-700">{t(`datasets.${dataset.descriptionKey}`)}</p>
            <p className="text-xs text-neutral-600">
              <code className="rounded bg-neutral-100 px-1">{apiUrl(dataset)}</code>
            </p>
            <p className="text-xs text-neutral-600">
              {t('apiFormatLabel')}: {dataset.formats.join(', ')}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-neutral-600">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{t('fieldName')}</th>
                    <th className="py-1 pr-3 font-medium">{t('fieldType')}</th>
                    <th className="py-1 font-medium">{t('fieldDescription')}</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.fields.map((field) => (
                    <tr key={field.name} className="border-t border-neutral-100 align-top">
                      <td className="py-1 pr-3">
                        <code>{field.name}</code>
                      </td>
                      <td className="py-1 pr-3 text-neutral-600">{field.type}</td>
                      <td className="py-1 text-neutral-700">
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
        <h2 className="text-lg font-semibold">{t('dumpsTitle')}</h2>
        <p className="text-neutral-700">{t('dumpsIntro')}</p>
        <p className="text-sm text-neutral-600">
          {t('dumpsRetention', { keep: Number(process.env.OPENDATA_DUMP_RETENTION ?? 30) })}
        </p>

        {manifest && manifest.files.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {t('dumpsLatest')}: <code>{manifest.version}</code>
            </p>
            <ul className="space-y-2 text-sm">
              {manifest.files.map((file) => (
                <li
                  key={`${file.dataset}.${file.format}`}
                  className="flex flex-wrap items-baseline gap-x-3 border-t border-neutral-100 pt-2"
                >
                  <a
                    className="text-teal-700 underline"
                    href={`/api/opendata/${OPEN_DATA_API_VERSION}/dumps/${file.version}/${file.dataset}.${file.format}`}
                  >
                    {file.dataset}.{file.format}
                  </a>
                  <span className="text-neutral-600">
                    {formatBytes(file.bytes)} · {file.rowCount} {t('dumpsRows')}
                  </span>
                  <code className="text-xs text-neutral-500">
                    {t('dumpsChecksum')} {file.sha256.slice(0, 16)}…
                  </code>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-neutral-600">{t('dumpsNone')}</p>
        )}

        <p className="text-sm">
          <a
            className="text-teal-700 underline"
            href={`/api/opendata/${OPEN_DATA_API_VERSION}/dumps`}
          >
            {t('dumpsManifest')}
          </a>
        </p>
      </section>

      <footer className="border-t border-neutral-200 pt-4 text-sm text-neutral-600">
        {OPEN_DATA_LICENSE.attribution}
      </footer>
    </main>
  );
}
