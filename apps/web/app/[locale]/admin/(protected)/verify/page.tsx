import { getTranslations, setRequestLocale } from 'next-intl/server';

import { municipalityOptions, verifyQueue } from '@/lib/admin-data';

import { VerifyDeck } from './verify-deck';

export default async function AdminVerifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const municipalityRaw = typeof sp.municipality === 'string' ? sp.municipality : '';
  const municipality =
    municipalityRaw === 'none'
      ? ('none' as const)
      : /^\d+$/.test(municipalityRaw)
        ? Number(municipalityRaw)
        : undefined;

  const [t, { cards, remaining }, municipalities] = await Promise.all([
    getTranslations('AdminVerify'),
    verifyQueue(municipality),
    municipalityOptions(),
  ]);

  return (
    <main className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <form method="get" className="flex items-center gap-2 text-sm">
          <label htmlFor="municipality" className="text-neutral-500">
            {t('municipalityFilter')}
          </label>
          <select
            id="municipality"
            name="municipality"
            defaultValue={municipality === 'none' ? 'none' : (municipality ?? '')}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            <option value="">{t('allMunicipalities')}</option>
            <option value="none">{t('noMunicipality')}</option>
            {municipalities.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nameBg}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-neutral-900 px-3 py-1 text-white">
            {t('apply')}
          </button>
        </form>
      </div>
      <VerifyDeck cards={cards} remaining={remaining} />
    </main>
  );
}
