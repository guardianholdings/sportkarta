/**
 * Which message namespaces reach the browser, and where (pre-launch audit,
 * findings 121 and 164).
 *
 * A `<NextIntlClientProvider>` with no `messages` prop serialises the WHOLE
 * catalogue into the page — all 66 namespaces, ~135 KB of JSON, ~37 KB gzipped
 * — although client components read only a handful. Every first page view
 * shipped the admin screens, the email bodies and the dev mail viewer's copy,
 * and paid ~20 ms of server CPU to serialise it. Server components need none of
 * this: they translate on the server from the full catalogue (i18n/request.ts).
 *
 * So the browser gets:
 * - `ROOT_CLIENT_NAMESPACES` on every page — the footer (in the root layout)
 *   and the map explorer (the home page, which has no segment of its own);
 * - plus a route's `CLIENT_SCOPES` entry under that route, through the layout in
 *   its `dir`. A nested provider REPLACES its parent's messages rather than
 *   merging with them, which is why a scope is always root + its own.
 *
 * KEPT HONEST BY tests/i18n-client-namespaces.test.ts, which walks the real
 * import graph from every route down to each `'use client'` boundary and fails
 * if a client component under some layout reads a namespace that layout does
 * not send (it would render raw keys), or if a list names one nobody reads.
 * Adding `useTranslations('X')` to a client component means adding X here.
 */

export const ROOT_CLIENT_NAMESPACES = [
  'Access',
  'Ads',
  'Facility',
  'Footer',
  'Map',
  'Nav',
  'Sport',
  'Surface',
] as const;

export const CLIENT_SCOPES = {
  admin: {
    dir: 'app/[locale]/admin/(protected)',
    namespaces: ['AdminAmbassadors', 'AdminCampaigns', 'AdminEdit', 'AdminMap', 'AdminVerify'],
  },
  addFacility: { dir: 'app/[locale]/dobavi', namespaces: ['AddFacility', 'Contribute'] },
  checkin: { dir: 'app/[locale]/otmetka', namespaces: ['Checkin'] },
  designSystem: { dir: 'app/[locale]/design-system', namespaces: ['DesignSystem'] },
  facility: {
    dir: 'app/[locale]/obekt',
    namespaces: ['Condition', 'ConditionTag', 'Contribute', 'Report'],
  },
  passport: { dir: 'app/[locale]/pasport', namespaces: ['Share'] },
  profile: { dir: 'app/[locale]/profil', namespaces: ['Profile'] },
  signIn: { dir: 'app/[locale]/vhod', namespaces: ['SignIn'] },
  stats: { dir: 'app/[locale]/statistika', namespaces: ['Stats'] },
} as const satisfies Record<string, { dir: string; namespaces: readonly string[] }>;

export type ClientScope = keyof typeof CLIENT_SCOPES;

/** The namespaces a provider for `scope` (or the root, with none) must carry. */
export function clientNamespaces(scope?: ClientScope): readonly string[] {
  return scope
    ? [...ROOT_CLIENT_NAMESPACES, ...CLIENT_SCOPES[scope].namespaces]
    : ROOT_CLIENT_NAMESPACES;
}

/** The subset of the catalogue a provider for `scope` sends to the browser. */
export function pickClientMessages<M extends Record<string, unknown>>(
  messages: M,
  scope?: ClientScope,
): Partial<M> {
  const picked: Partial<M> = {};
  for (const namespace of clientNamespaces(scope)) {
    if (namespace in messages) picked[namespace as keyof M] = messages[namespace as keyof M];
  }
  return picked;
}
