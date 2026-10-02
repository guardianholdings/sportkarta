/**
 * Pass-through root layout. The real document — <html lang>, fonts, the intl
 * provider — is app/[locale]/layout.tsx, because the lang attribute depends on
 * the locale segment.
 *
 * This file exists for the two boundaries that must sit ABOVE the locale:
 * app/not-found.tsx (a path whose first segment is not a locale at all, which
 * [locale]/layout.tsx rejects with notFound()) and app/global-error.tsx (the
 * locale layout itself failing). Next requires a root layout for a root
 * not-found; without one it rendered its own bare English page with no lang.
 * Both of those files therefore render their own <html> and <body>.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
