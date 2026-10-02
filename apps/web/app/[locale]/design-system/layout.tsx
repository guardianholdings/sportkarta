import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { scopedMessagesLayout } from '@/i18n/client-intl-provider';

/**
 * The component catalogue is a development aid («Вътрешна референция»), and
 * in production it was a public, indexable page under the brand. Gated here,
 * exactly like /dev/poshta, rather than in the page: the page is a client
 * component, and a layout is the server-side place a whole route can be
 * refused. With no loading boundary above it the refusal is a real 404.
 *
 * It stays off static.xml for the same reason (lib/sitemap-static.ts).
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

// Sends this route's client components the message namespaces they read, on
// top of the root set (i18n/client-messages.ts, scope 'designSystem').
const ScopedMessages = scopedMessagesLayout('designSystem');

export default function DesignSystemLayout(props: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ScopedMessages {...props} />;
}
