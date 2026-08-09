import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { revokeApiKeyAction } from './actions';

import { CreateKeyForm } from '@/components/opendata/create-key-form';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { listApiKeys, MAX_KEYS_PER_ACCOUNT } from '@/lib/opendata/keys';
import { OPEN_DATA_LIMITS } from '@/lib/opendata/limits';
import { buildAlternates } from '@/lib/seo';
import { AppShell } from '@/components/shell/app-shell';

/**
 * Self-service API keys (Stage 6.1).
 *
 * Signed in, instant, free, and unreviewed — a key buys throughput, not access,
 * so there is nothing here to approve. The page never shows a key after the
 * moment it was created, because there is nothing to show: only a SHA-256 is
 * stored, in a column whose CHECK cannot hold a key at all (migration 0015).
 * The prefix column exists solely so a member can tell three keys apart when
 * revoking one.
 *
 * `/danni/klyuchove` is NOT in middleware.ts's PROTECTED_PATH: that list is an
 * optimistic cookie check to avoid rendering a shell for signed-out visitors,
 * and this page gates itself properly with requireUser(). Adding it there would
 * be belt and braces; leaving it out costs a redirect one level later.
 */

type PageParams = Promise<{ locale: string }>;

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'OpenData' });
  return {
    title: t('keysTitle'),
    // A page listing somebody's credentials has no business in an index.
    robots: { index: false, follow: false },
    alternates: buildAlternates('/danni/klyuchove', locale),
  };
}

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale === 'bg' ? 'bg-BG' : 'en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default async function ApiKeysPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requireUser();
  const t = await getTranslations('OpenData');
  const keys = await listApiKeys(user.id);

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <Link href="/danni" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('back')}
        </Link>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('keysTitle')}</h1>
        <p className="text-ink-soft">
          {t('keysIntro', {
            anon: OPEN_DATA_LIMITS.anonPerMinute,
            keyed: OPEN_DATA_LIMITS.keyedPerMinute,
          })}
        </p>

        <CreateKeyForm
          strings={{
            labelField: t('keysLabelField'),
            labelHint: t('keysLabelHint'),
            create: t('keysCreate'),
            created: t('keysCreated'),
            copyHint: t('keysCopyHint'),
            errors: {
              keysLabelRequired: t('keysLabelRequired'),
              keysLimitReached: t('keysLimitReached', { max: MAX_KEYS_PER_ACCOUNT }),
              keysLabelLooksLikeKey: t('keysLabelLooksLikeKey'),
            },
          }}
        />

        <section className="space-y-2">
          {keys.length === 0 ? (
            <p className="text-body-sm text-ink-soft">{t('keysEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-body-sm">
                <thead className="text-ink-soft">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{t('keysColumnLabel')}</th>
                    <th className="py-1 pr-3 font-medium">{t('keysColumnPrefix')}</th>
                    <th className="py-1 pr-3 font-medium">{t('keysColumnCreated')}</th>
                    <th className="py-1 pr-3 font-medium">{t('keysColumnLastUsed')}</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id} className="border-t border-line">
                      <td className="py-2 pr-3">{key.label}</td>
                      <td className="py-2 pr-3">
                        <code className="text-caption">{key.prefix}…</code>
                      </td>
                      <td className="py-2 pr-3 text-ink-soft">
                        {formatDate(key.createdAt, locale)}
                      </td>
                      <td className="py-2 pr-3 text-ink-soft">
                        {key.lastUsedAt ? formatDate(key.lastUsedAt, locale) : t('keysNeverUsed')}
                      </td>
                      <td className="py-2">
                        {/* Plain form: revocation must work before hydration —
                          it is the one action somebody takes in a hurry. */}
                        <form action={revokeApiKeyAction}>
                          <input type="hidden" name="keyId" value={key.id} />
                          <button
                            type="submit"
                            className="min-h-11 rounded-pill border border-line-strong bg-surface px-4 text-caption font-semibold text-ink-soft hover:bg-surface-2"
                          >
                            {t('keysRevoke')}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-1">
          <h2 className="text-h4 font-bold text-ink">{t('keysUsageTitle')}</h2>
          <p className="text-body-sm text-ink-soft">{t('keysHeaderOnly')}</p>
          {/* Shell, not UI text — deliberately not translated. */}
          <pre className="overflow-x-auto rounded-md bg-paper-sunk p-3 font-mono text-caption text-ink">
            {'curl -H "Authorization: Bearer skbg_…" \\\n  ".../api/opendata/v1/facilities"'}
          </pre>
        </section>
      </main>
    </AppShell>
  );
}
