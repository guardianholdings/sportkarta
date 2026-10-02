import { scopedMessagesLayout } from '@/i18n/client-intl-provider';

// Sends this route's client components the message namespaces they read, on
// top of the root set (i18n/client-messages.ts, scope 'signIn').
export default scopedMessagesLayout('signIn');
