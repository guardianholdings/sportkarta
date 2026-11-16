/**
 * schema.org structured data, built in one place.
 *
 * WHY IT EXISTS. Only the facility page described itself to a machine. The
 * front page said nothing about who runs the site, a city listing was an
 * anonymous list of links, the questions-and-answers sections were prose, and
 * the open-data page — a public dataset under a free licence — carried no
 * `Dataset` at all. A search engine works that out eventually; an answer
 * engine quoting the site mostly does not, and cites someone else.
 *
 * THREE RULES every builder here keeps:
 *
 * 1. MARKUP REPEATS THE PAGE, never adds to it. A builder takes the strings
 *    the page already renders (a question and its answer, a list row's name)
 *    and nothing else, so the markup cannot claim what a visitor cannot read.
 * 2. AN ABSENT FACT IS ABSENT. `prune` drops null, undefined and empty values,
 *    so an unset ORG_LEGAL_NAME yields no `legalName` rather than an empty one
 *    — the same fail-closed rule as lib/organisation.ts.
 * 3. NO PERSON, EVER. Nothing here takes a member, a handle, a trainer or a
 *    personal contact; the public individual surfaces are opt-in and noindex,
 *    and structured data would be a second, unguarded way to publish them. A
 *    club's phone and e-mail stay on its page for the same reason: for a
 *    one-trainer studio they are a person's own.
 *
 * Pure and synchronous: the origin comes from lib/seo.ts, every string from
 * the caller. Serialisation (and its XSS escaping) stays in lib/json-ld.ts.
 */
import { siteUrl } from '@/lib/seo';

export type JsonLdNode = Record<string, unknown>;

const CONTEXT = 'https://schema.org';

/** Drops what is not known, at every depth; an object left with no fact goes too. */
function prune<T>(value: T): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return (value.trim() === '' ? undefined : value) as T | undefined;
  if (Array.isArray(value)) {
    const kept = value.map((item) => prune(item)).filter((item) => item !== undefined);
    return (kept.length > 0 ? kept : undefined) as T | undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => [key, prune(inner)] as const)
      .filter(([, inner]) => inner !== undefined);
    // A node that kept only its type says nothing. A bare reference
    // (`{ '@id': … }`) says exactly one thing, and stays.
    if (entries.every(([key]) => key === '@type')) return undefined;
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/**
 * The public address of a locale-agnostic path (leading slash, no locale
 * prefix): Bulgarian unprefixed, English under /en — the rule
 * lib/seo.ts buildAlternates applies to canonicals, so a URL in the markup is
 * always the page's own canonical.
 */
export function pageUrl(path: string, locale: string): string {
  const rel = path === '/' ? '' : path;
  return locale === 'en' ? `${siteUrl()}/en${rel}` : `${siteUrl()}${rel || '/'}`;
}

/** Stable node ids, so every page can point at the one organisation and site. */
export function organizationId(): string {
  return `${siteUrl()}/#organization`;
}
export function websiteId(): string {
  return `${siteUrl()}/#website`;
}

/** One `@graph` document; nodes that pruned away to nothing are left out. */
export function graph(...nodes: (JsonLdNode | null | undefined)[]): JsonLdNode {
  return {
    '@context': CONTEXT,
    '@graph': nodes
      .map((node) => (node ? prune(node) : undefined))
      .filter((node): node is JsonLdNode => node !== undefined),
  };
}

export interface OrganizationInput {
  /** The short brand name, as people search for it. */
  name: string;
  /** The name written out. */
  alternateName: string;
  description: string;
  /** Operator data from lib/organisation.ts; each one may be unset. */
  legalName: string | null;
  email: string | null;
  address: string | null;
  taxId: string | null;
  vatId: string | null;
}

/** Who runs the site: a non-profit association, with what it has published about itself. */
export function organizationNode(input: OrganizationInput): JsonLdNode {
  const origin = siteUrl();
  return {
    '@type': 'NGO',
    '@id': organizationId(),
    name: input.name,
    alternateName: input.alternateName,
    legalName: input.legalName,
    description: input.description,
    url: `${origin}/`,
    logo: {
      '@type': 'ImageObject',
      url: `${origin}/icons/icon-512.png`,
      width: 512,
      height: 512,
    },
    email: input.email,
    address: input.address,
    taxID: input.taxId,
    vatID: input.vatId,
    areaServed: { '@type': 'Country', identifier: 'BG' },
  };
}

/** The site itself, in both of its languages, published by the organisation. */
export function websiteNode(input: {
  name: string;
  alternateName: string;
  description: string;
}): JsonLdNode {
  return {
    '@type': 'WebSite',
    '@id': websiteId(),
    url: `${siteUrl()}/`,
    name: input.name,
    alternateName: input.alternateName,
    description: input.description,
    inLanguage: ['bg', 'en'],
    publisher: { '@id': organizationId() },
  };
}

export interface Crumb {
  name: string;
  /** Locale-agnostic path, leading slash. */
  path: string;
}

/** The page's place in the site, outermost first; the last crumb is the page. */
export function breadcrumbList(crumbs: Crumb[], locale: string): JsonLdNode {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: pageUrl(crumb.path, locale),
    })),
  };
}

export interface QuestionAnswer {
  question: string;
  answer: string;
}

/**
 * A questions-and-answers section. Null for an empty list — a `FAQPage` with
 * no question is an error to every validator, and a club that has written no
 * answers yet must not publish one.
 */
export function faqPage(entries: QuestionAnswer[]): JsonLdNode | null {
  const asked = entries.filter((entry) => entry.question.trim() && entry.answer.trim());
  if (asked.length === 0) return null;
  return {
    '@type': 'FAQPage',
    mainEntity: asked.map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: { '@type': 'Answer', text: entry.answer },
    })),
  };
}

/**
 * A listing page's rows, in the order shown. `total` is the size of the whole
 * listing when the page shows one slice of it; null for an empty slice.
 */
export function itemList(input: {
  name: string;
  items: Crumb[];
  total?: number;
  locale: string;
}): JsonLdNode | null {
  if (input.items.length === 0) return null;
  return {
    '@type': 'ItemList',
    name: input.name,
    numberOfItems: input.total ?? input.items.length,
    itemListElement: input.items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      url: pageUrl(item.path, input.locale),
    })),
  };
}

export interface DatasetInput {
  /** Stable within the page; becomes the node's fragment id. */
  id: string;
  name: string;
  description: string;
  /** The documentation page, locale-agnostic. */
  path: string;
  locale: string;
  license: string;
  /** One entry per published format. */
  distributions: { format: string; url: string }[];
  /** What a column means, as the documentation table prints it. */
  variables: string[];
}

/** IANA media types of the formats the open-data API serves. */
const MEDIA_TYPE: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  geojson: 'application/geo+json',
};

/** An open dataset: free to read, under a named licence, covering Bulgaria. */
export function datasetNode(input: DatasetInput): JsonLdNode {
  return {
    '@type': 'Dataset',
    // ONE dataset, documented in two languages: the id is the Bulgarian
    // page's in both, so /danni and /en/danni describe the same thing instead
    // of minting a twin. The rows themselves are Bulgarian (place names,
    // facility names) whatever language the documentation is read in.
    '@id': `${pageUrl(input.path, 'bg')}#${input.id}`,
    name: input.name,
    description: input.description,
    url: pageUrl(input.path, input.locale),
    inLanguage: 'bg',
    license: input.license,
    isAccessibleForFree: true,
    creator: { '@id': organizationId() },
    publisher: { '@id': organizationId() },
    spatialCoverage: { '@type': 'Country', identifier: 'BG' },
    variableMeasured: input.variables,
    distribution: input.distributions.map((distribution) => ({
      '@type': 'DataDownload',
      encodingFormat: MEDIA_TYPE[distribution.format.toLowerCase()] ?? distribution.format,
      contentUrl: distribution.url,
    })),
  };
}

export interface PricedTier {
  name: string;
  /** Whole cents, as lib/clubs prices are kept. */
  priceCents: number;
}

/**
 * The clubs platform as the product it is sold as: one application, one offer
 * per tier. Prices are NET of VAT (operator decision 2026-11-06, the page
 * prints them so), and the markup says so rather than leaving a reader to
 * assume the consumer convention.
 */
export function clubsPlatformNode(input: {
  name: string;
  description: string;
  path: string;
  locale: string;
  tiers: PricedTier[];
}): JsonLdNode {
  const url = pageUrl(input.path, input.locale);
  return {
    '@type': 'SoftwareApplication',
    '@id': `${url}#platform`,
    name: input.name,
    description: input.description,
    url,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    provider: { '@id': organizationId() },
    offers: input.tiers.map((tier) => ({
      '@type': 'Offer',
      name: tier.name,
      url,
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: (tier.priceCents / 100).toFixed(2),
        priceCurrency: 'EUR',
        valueAddedTaxIncluded: false,
        billingDuration: 'P1M',
      },
    })),
  };
}

/** A club, gym or studio, with what it chose to publish about itself as an organisation. */
export function clubNode(input: {
  name: string;
  description: string | null;
  slug: string;
  locale: string;
  website: string | null;
  /** One line per venue, as the page prints it. */
  addresses: string[];
}): JsonLdNode {
  const url = pageUrl(`/klub/${input.slug}`, input.locale);
  return {
    '@type': 'SportsActivityLocation',
    '@id': `${url}#club`,
    name: input.name,
    description: input.description,
    url,
    sameAs: input.website,
    address: input.addresses.map((line) => ({
      '@type': 'PostalAddress',
      streetAddress: line,
      addressCountry: 'BG',
    })),
  };
}
