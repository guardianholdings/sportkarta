import { getTranslations } from 'next-intl/server';

import { setPassportVisibilityAction } from '@/app/[locale]/pasport/actions';
import type { OwnPassport } from '@/lib/passport';

/**
 * Passport visibility controls.
 *
 * Plain forms rather than a client component, matching the digest panel: three
 * buttons that must work before hydration. Each button posts the TARGET state
 * rather than "flip it", so a double tap settles instead of flapping — which
 * matters more here than for a digest, because the flapping value is whether a
 * page about somebody is publicly readable.
 *
 * A minor is shown an explanation, not a disabled toggle: the rule is not a
 * temporary condition of the UI, it is why the feature does not apply to them.
 */
export async function VisibilityPanel({
  visibility,
  publicUrl,
}: {
  visibility: OwnPassport['visibility'];
  publicUrl: string | null;
}) {
  const t = await getTranslations('Passport');

  if (!visibility.canPublish) {
    return (
      <section className="space-y-2 rounded border border-neutral-200 p-4">
        <h2 className="text-lg font-semibold">{t('visibilityTitle')}</h2>
        <p className="text-sm text-neutral-600">{t('visibilityMinor')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded border border-neutral-200 p-4">
      <h2 className="text-lg font-semibold">{t('visibilityTitle')}</h2>
      <p className="text-sm text-neutral-600">
        {visibility.isPublic ? t('visibilityPublicExplainer') : t('visibilityPrivateExplainer')}
      </p>

      <form action={setPassportVisibilityAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="isPublic" value={visibility.isPublic ? 'false' : 'true'} />
        <input
          type="hidden"
          name="showActivity"
          value={visibility.showActivity ? 'true' : 'false'}
        />
        <button
          type="submit"
          className={
            visibility.isPublic
              ? 'rounded border border-neutral-300 px-3 py-1.5 text-sm'
              : 'rounded bg-neutral-900 px-3 py-1.5 text-sm text-white'
          }
        >
          {visibility.isPublic ? t('makePrivate') : t('makePublic')}
        </button>
      </form>

      {visibility.isPublic && publicUrl && (
        <p className="break-all text-sm">
          <a href={publicUrl} className="underline">
            {publicUrl}
          </a>
        </p>
      )}

      {visibility.isPublic && (
        <form action={setPassportVisibilityAction} className="space-y-2">
          <input type="hidden" name="isPublic" value="true" />
          <input
            type="hidden"
            name="showActivity"
            value={visibility.showActivity ? 'false' : 'true'}
          />
          <p className="text-sm text-neutral-600">{t('activityExplainer')}</p>
          <button type="submit" className="rounded border border-neutral-300 px-3 py-1.5 text-sm">
            {visibility.showActivity ? t('hideActivity') : t('showActivity')}
          </button>
        </form>
      )}
    </section>
  );
}
