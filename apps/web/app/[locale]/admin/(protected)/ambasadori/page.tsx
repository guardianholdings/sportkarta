import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';

import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { municipalityOptions } from '@/lib/admin-data';
import { requireRole } from '@/lib/auth-session';
import { ambassadorActivity } from '@/lib/moderation-data';

import { addMunicipalityAction, removeMunicipalityAction, revokeAmbassadorAction } from './actions';
import { GrantForm } from './grant-form';

export const metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * Who moderates what, and how they are doing (Stage 3.3).
 *
 * Admin-only: an ambassador must not be able to widen their own scope, so this
 * page uses requireRole('admin') rather than the panel-level gate.
 */
export default async function AdminAmbassadorsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const [t, ambassadors, municipalities, activeLocale] = await Promise.all([
    getTranslations('AdminAmbassadors'),
    ambassadorActivity(),
    municipalityOptions(),
    getLocale(),
  ]);

  const formatDate = (value: string): string =>
    new Intl.DateTimeFormat(activeLocale, { dateStyle: 'medium' }).format(new Date(value));
  const formatHours = (hours: number | null): string =>
    hours === null ? t('noData') : t('hours', { hours: hours.toFixed(1) });

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-neutral-600">{t('intro')}</p>
      </div>

      <section className="space-y-2 rounded border border-neutral-200 p-4">
        <h2 className="font-medium">{t('grantTitle')}</h2>
        <GrantForm />
        <p className="text-xs text-neutral-500">{t('grantHint')}</p>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">{t('listTitle')}</h2>
        {ambassadors.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500">
            {t('empty')}
          </p>
        ) : (
          <ul className="space-y-3">
            {ambassadors.map((ambassador) => {
              const revoke = revokeAmbassadorAction.bind(null, ambassador.userId);
              const ambassadorName = ambassador.displayName || ambassador.email;
              return (
                <li
                  key={ambassador.userId}
                  className="space-y-3 rounded border border-neutral-200 p-4"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">
                      {ambassador.displayName || ambassador.email}
                    </span>
                    <span className="text-xs text-neutral-500">{ambassador.email}</span>
                    <form action={revoke} className="ml-auto">
                      <ConfirmButton
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                        message={t('revokeConfirm', { name: ambassadorName })}
                      >
                        {t('revoke')}
                      </ConfirmButton>
                    </form>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                    <div>
                      <dt className="text-neutral-500">{t('decisions')}</dt>
                      <dd className="font-medium">{ambassador.decisions}</dd>
                    </div>
                    <div>
                      <dt className="text-neutral-500">{t('medianTime')}</dt>
                      <dd className="font-medium">{formatHours(ambassador.medianHours)}</dd>
                    </div>
                    <div>
                      <dt className="text-neutral-500">{t('lastActive')}</dt>
                      <dd className="font-medium">
                        {ambassador.lastDecisionAt
                          ? formatDate(ambassador.lastDecisionAt)
                          : t('never')}
                      </dd>
                    </div>
                  </dl>

                  <div className="space-y-2">
                    <h3 className="text-xs font-medium text-neutral-500">{t('scope')}</h3>
                    {ambassador.municipalities.length === 0 ? (
                      <p className="text-xs text-amber-700">{t('noScope')}</p>
                    ) : (
                      <ul className="flex flex-wrap gap-2">
                        {ambassador.municipalities.map((municipality) => {
                          const remove = removeMunicipalityAction.bind(
                            null,
                            ambassador.userId,
                            municipality.id,
                          );
                          return (
                            <li key={municipality.id}>
                              <form action={remove}>
                                <ConfirmButton
                                  className="rounded-full border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50"
                                  aria-label={t('removeMunicipality', {
                                    municipality: municipality.name,
                                  })}
                                  message={t('removeMunicipalityConfirm', {
                                    municipality: municipality.name,
                                  })}
                                >
                                  {municipality.name} ×
                                </ConfirmButton>
                              </form>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    <form action={addMunicipalityAction} className="flex flex-wrap gap-2">
                      <input type="hidden" name="userId" value={ambassador.userId} />
                      <select
                        name="municipalityId"
                        aria-label={t('addMunicipality')}
                        className="rounded border border-neutral-300 px-2 py-1 text-xs"
                      >
                        {municipalities.map((municipality) => (
                          <option key={municipality.id} value={municipality.id}>
                            {municipality.nameBg}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" variant="secondary" size="sm">
                        {t('addMunicipality')}
                      </Button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
