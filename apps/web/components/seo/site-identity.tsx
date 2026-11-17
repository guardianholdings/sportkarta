import { getTranslations } from 'next-intl/server';

import { GUIDE_FAQ_KEYS } from '@/components/guide/faq';
import { organisation } from '@/lib/organisation';
import { faqPage, graph, organizationNode, websiteNode } from '@/lib/structured-data';

import { JsonLd } from './json-ld';

/**
 * Who runs the site and what the site is — said once, on the front page, and
 * referred to by id from every other page's markup (lib/structured-data.ts).
 *
 * The association's registered name, ЕИК, address and inbox come from
 * lib/organisation.ts, i.e. from the same operator-set values the privacy and
 * contact pages print; an unset one is simply absent here too.
 *
 * `faq`: a visitor's front page ends with the questions a first visit asks, a
 * member's does not — and markup may only repeat what the page shows.
 */
export async function SiteIdentity({ locale, faq }: { locale: string; faq: boolean }) {
  const [tMeta, tManifest, tOg, tOgBg, tFaq] = await Promise.all([
    getTranslations({ locale, namespace: 'Metadata' }),
    getTranslations({ locale, namespace: 'Manifest' }),
    getTranslations({ locale, namespace: 'Og' }),
    // The association's name written out is Bulgarian in either language.
    getTranslations({ locale: 'bg', namespace: 'Og' }),
    getTranslations({ locale, namespace: 'Home.guide.faq' }),
  ]);
  const org = organisation();
  const name = tManifest('shortName');
  const description = tMeta('description');

  return (
    <JsonLd
      data={graph(
        organizationNode({
          name,
          alternateName: tOgBg('wordmark'),
          description,
          legalName: org.legalName,
          email: org.contactEmail,
          address: org.address,
          taxId: org.eik,
          vatId: org.vatNumber,
        }),
        websiteNode({ name, alternateName: tOg('site.title'), description }),
        faq
          ? faqPage(
              GUIDE_FAQ_KEYS.map((key) => ({
                question: tFaq(`${key}.q`),
                answer: tFaq(`${key}.a`),
              })),
            )
          : null,
      )}
    />
  );
}
