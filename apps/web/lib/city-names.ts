import cityOverrides from './city-overrides.json';

// Client-safe display-name resolver: applies the same city overrides the
// /igrishta pages use (e.g. municipality "Столична" → "София"/"Sofia"), so a
// municipality reads consistently across the site. Only the JSON is imported —
// no DB — so this is safe in client components.
const OVERRIDES = cityOverrides as Record<string, { slug: string; nameBg: string; nameEn: string }>;

export function cityDisplayName(nameBg: string, nameEn: string, locale: string): string {
  const override = OVERRIDES[nameBg];
  const bg = override?.nameBg ?? nameBg;
  const en = override?.nameEn ?? nameEn;
  return locale === 'en' ? en : bg;
}
