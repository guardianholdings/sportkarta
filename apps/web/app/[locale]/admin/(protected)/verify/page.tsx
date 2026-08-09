import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { municipalityOptions, verifyQueue } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/auth-session';

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

  // The deck is scoped to what this account may actually decide.
  const user = await requireAdmin();
  const [t, { cards, remaining }, municipalities] = await Promise.all([
    getTranslations('AdminVerify'),
    verifyQueue({ id: user.id, role: user.role }, municipality),
    municipalityOptions(),
  ]);

  return (
    <main className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <form method="get" className="flex items-center gap-2">
          <label htmlFor="municipality" className="text-caption font-medium text-ink-soft">
            {t('municipalityFilter')}
          </label>
          <div className="w-56">
            <Select
              id="municipality"
              name="municipality"
              size="sm"
              defaultValue={municipality === 'none' ? 'none' : (municipality ?? '')}
            >
              <option value="">{t('allMunicipalities')}</option>
              <option value="none">{t('noMunicipality')}</option>
              {municipalities.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nameBg}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" size="sm">
            {t('apply')}
          </Button>
        </form>
      </div>
      <VerifyDeck cards={cards} remaining={remaining} />
    </main>
  );
}
