import { describe, expect, it } from 'vitest';

import { serializeJsonLd } from '../lib/json-ld';
import { siteUrl } from '../lib/seo';
import {
  breadcrumbList,
  clubNode,
  clubsPlatformNode,
  datasetNode,
  faqPage,
  graph,
  itemList,
  organizationId,
  organizationNode,
  pageUrl,
  websiteId,
  websiteNode,
} from '../lib/structured-data';

/**
 * The structured-data builders (lib/structured-data.ts). Every failure here is
 * silent in a browser: a page with broken or dishonest markup looks exactly
 * like a page with good markup, and the only reader that notices is a search
 * or answer engine, weeks later.
 */

type Node = Record<string, unknown>;
const nodes = (doc: Node) => doc['@graph'] as Node[];
const ORIGIN = siteUrl();

const ORG = {
  name: 'POPS',
  alternateName: 'Written-out name',
  description: 'A national map.',
  legalName: null,
  email: null,
  address: null,
  taxId: null,
  vatId: null,
};

describe('pageUrl', () => {
  it('serves Bulgarian unprefixed and English under /en, like the canonicals', () => {
    expect(pageUrl('/karta', 'bg')).toBe(`${ORIGIN}/karta`);
    expect(pageUrl('/karta', 'en')).toBe(`${ORIGIN}/en/karta`);
    expect(pageUrl('/', 'bg')).toBe(`${ORIGIN}/`);
    expect(pageUrl('/', 'en')).toBe(`${ORIGIN}/en`);
  });
});

describe('graph', () => {
  it('is one schema.org document and leaves out what is not there', () => {
    const doc = graph(websiteNode(ORG), null, undefined, faqPage([]));
    expect(doc['@context']).toBe('https://schema.org');
    expect(nodes(doc)).toHaveLength(1);
  });

  it('drops a node that kept nothing but its type', () => {
    expect(nodes(graph({ '@type': 'Thing', name: '', url: null }))).toEqual([]);
  });
});

describe('the organisation', () => {
  it('states only what the operator has set', () => {
    const [bare] = nodes(graph(organizationNode(ORG)));
    expect(bare).toMatchObject({ '@type': 'NGO', '@id': organizationId(), name: 'POPS' });
    for (const key of ['legalName', 'email', 'address', 'taxID', 'vatID']) {
      expect(bare, key).not.toHaveProperty(key);
    }

    const [full] = nodes(
      graph(
        organizationNode({
          ...ORG,
          legalName: 'Registered Name',
          email: 'office@example.org',
          address: 'One line',
          taxId: '000000000',
          vatId: 'BG000000000',
        }),
      ),
    );
    expect(full).toMatchObject({
      legalName: 'Registered Name',
      email: 'office@example.org',
      taxID: '000000000',
      vatID: 'BG000000000',
    });
  });

  it('points its logo at a file this app serves, by absolute address', () => {
    const [org] = nodes(graph(organizationNode(ORG)));
    expect((org?.logo as Node).url).toBe(`${ORIGIN}/icons/icon-512.png`);
  });

  it('is what the site names as its publisher', () => {
    const [site] = nodes(graph(websiteNode(ORG)));
    expect(site).toMatchObject({ '@type': 'WebSite', '@id': websiteId() });
    expect(site?.publisher).toEqual({ '@id': organizationId() });
    expect(site?.inLanguage).toEqual(['bg', 'en']);
  });
});

describe('breadcrumbList', () => {
  it('numbers the trail from one and links each step in the page’s language', () => {
    const list = breadcrumbList(
      [
        { name: 'POPS', path: '/' },
        { name: 'City', path: '/igrishta/varna' },
      ],
      'en',
    );
    const items = list.itemListElement as Node[];
    expect(items.map((item) => item.position)).toEqual([1, 2]);
    expect(items[0]?.item).toBe(`${ORIGIN}/en`);
    expect(items[1]).toMatchObject({ name: 'City', item: `${ORIGIN}/en/igrishta/varna` });
  });
});

describe('faqPage', () => {
  it('is null with nothing to ask — an empty FAQPage is an error to every validator', () => {
    expect(faqPage([])).toBeNull();
    expect(faqPage([{ question: 'Asked?', answer: '   ' }])).toBeNull();
  });

  it('repeats each question with its answer, in order', () => {
    const page = faqPage([
      { question: 'Is it free?', answer: 'Yes.' },
      { question: 'Whose data?', answer: 'Everyone’s.' },
    ]);
    const asked = page?.mainEntity as Node[];
    expect(asked.map((entry) => entry.name)).toEqual(['Is it free?', 'Whose data?']);
    expect(asked[0]?.acceptedAnswer).toEqual({ '@type': 'Answer', text: 'Yes.' });
  });
});

describe('itemList', () => {
  it('is null for an empty slice', () => {
    expect(itemList({ name: 'Listing', items: [], locale: 'bg' })).toBeNull();
  });

  it('counts the whole listing while listing the slice shown', () => {
    const list = itemList({
      name: 'Listing',
      total: 1589,
      locale: 'bg',
      items: [
        { name: 'First', path: '/obekt/a' },
        { name: 'Second', path: '/obekt/b' },
      ],
    });
    expect(list?.numberOfItems).toBe(1589);
    const rows = list?.itemListElement as Node[];
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ position: 2, name: 'Second', url: `${ORIGIN}/obekt/b` });
  });
});

describe('datasetNode', () => {
  const dataset = datasetNode({
    id: 'facilities',
    name: 'Facilities',
    description: 'Every public facility.',
    path: '/danni',
    locale: 'bg',
    license: 'https://opendatacommons.org/licenses/odbl/1-0/',
    distributions: [
      { format: 'geojson', url: `${ORIGIN}/api/opendata/v1/facilities?format=geojson` },
      { format: 'csv', url: `${ORIGIN}/api/opendata/v1/facilities?format=csv` },
    ],
    variables: ['slug', 'name'],
  });

  it('is free, licensed and published by the organisation', () => {
    expect(dataset).toMatchObject({
      '@type': 'Dataset',
      '@id': `${ORIGIN}/danni#facilities`,
      isAccessibleForFree: true,
      license: 'https://opendatacommons.org/licenses/odbl/1-0/',
      creator: { '@id': organizationId() },
    });
  });

  it('names each download by its registered media type', () => {
    const downloads = dataset.distribution as Node[];
    expect(downloads.map((entry) => entry.encodingFormat)).toEqual([
      'application/geo+json',
      'text/csv',
    ]);
  });
});

describe('clubsPlatformNode', () => {
  it('prices each tier in euro, net of VAT, per month', () => {
    const platform = clubsPlatformNode({
      name: 'POPS Clubs',
      description: 'Run a club.',
      path: '/za-klubove',
      locale: 'bg',
      tiers: [
        { name: 'Basic', priceCents: 4999 },
        { name: 'Pro', priceCents: 14999 },
      ],
    });
    const offers = platform.offers as Node[];
    expect(offers.map((offer) => (offer.priceSpecification as Node).price)).toEqual([
      '49.99',
      '149.99',
    ]);
    expect(offers[0]?.priceSpecification).toMatchObject({
      priceCurrency: 'EUR',
      valueAddedTaxIncluded: false,
      billingDuration: 'P1M',
    });
  });
});

describe('clubNode', () => {
  const club = {
    name: 'Studio',
    description: null,
    slug: 'studio',
    locale: 'bg',
    website: null,
    addresses: [],
  };

  it('publishes no personal contact — a one-trainer studio’s phone is a person’s', () => {
    const [node] = nodes(
      graph(clubNode({ ...club, website: 'https://studio.example', addresses: ['1 Main St'] })),
    );
    expect(Object.keys(node ?? {}).sort()).toEqual(
      ['@id', '@type', 'address', 'name', 'sameAs', 'url'].sort(),
    );
  });

  it('leaves out what the club has not written', () => {
    const [node] = nodes(graph(clubNode(club)));
    expect(node).toEqual({
      '@type': 'SportsActivityLocation',
      '@id': `${ORIGIN}/klub/studio#club`,
      name: 'Studio',
      url: `${ORIGIN}/klub/studio`,
    });
  });

  it('cannot close its own element, whatever a stranger typed as the name', () => {
    const hostile = clubNode({ ...club, name: '</script><script>alert(1)</script>' });
    const html = serializeJsonLd(graph(hostile));
    expect(html).not.toContain('</script');
    expect(html).not.toContain('<script');
    expect((JSON.parse(html) as Node)['@graph']).toHaveLength(1);
  });
});
