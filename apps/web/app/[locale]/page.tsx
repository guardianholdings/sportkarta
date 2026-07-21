import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('HomePage');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">{t('title')}</h1>
      <p className="text-muted-foreground max-w-prose text-center text-lg">{t('tagline')}</p>
      <Button size="lg">{t('cta')}</Button>
    </main>
  );
}
