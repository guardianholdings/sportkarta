import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';

import { type ClientScope, pickClientMessages } from './client-messages';

/**
 * The ONE way messages are handed to client components: only the namespaces
 * listed for this scope in i18n/client-messages.ts, never the whole catalogue
 * (which is what a bare `<NextIntlClientProvider>` sends).
 *
 * The locale is passed explicitly and set for the request first. Without that,
 * next-intl resolves it from the request headers, which would turn the ISR
 * pages under a scoped layout into per-request renders.
 */
export async function ClientIntlProvider({
  locale,
  scope,
  children,
}: {
  locale: string;
  scope?: ClientScope;
  children: React.ReactNode;
}) {
  setRequestLocale(locale);
  const messages = await getMessages({ locale });
  return (
    <NextIntlClientProvider locale={locale} messages={pickClientMessages(messages, scope)}>
      {children}
    </NextIntlClientProvider>
  );
}

/**
 * A layout that only widens the client messages for its route — the whole
 * body of the scoped `layout.tsx` files (see CLIENT_SCOPES for which).
 */
export function scopedMessagesLayout(scope: ClientScope) {
  return async function ScopedMessagesLayout({
    children,
    params,
  }: {
    children: React.ReactNode;
    params: Promise<{ locale: string }>;
  }) {
    const { locale } = await params;
    return (
      <ClientIntlProvider locale={locale} scope={scope}>
        {children}
      </ClientIntlProvider>
    );
  };
}
