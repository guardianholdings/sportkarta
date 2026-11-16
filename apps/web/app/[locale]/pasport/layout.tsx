import type { Metadata } from 'next';

import { scopedMessagesLayout } from '@/i18n/client-intl-provider';

// A passport's handle stays out of the next page's referrer.
export const metadata: Metadata = { referrer: 'no-referrer' };

// Sends this route's client components the message namespaces they read, on
// top of the root set (i18n/client-messages.ts, scope 'passport').
export default scopedMessagesLayout('passport');
