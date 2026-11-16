/**
 * /llms.txt — the site described for a language model, in the llmstxt.org
 * shape: one H1, a quoted summary, a few plain statements, then H2 sections
 * that are nothing but annotated links.
 *
 * An answer engine asked "where can I play basketball for free in Varna?" has
 * to decide, from one fetch, what this site is, whether its data may be
 * quoted, and which URL holds the answer. The pages say all of that, spread
 * over a guide, a licence page and an API reference; this file says it in
 * forty lines, with the licence and the attribution string beside the link to
 * the data — the two facts a model needs before it may repeat anything.
 *
 * EVERY SENTENCE COMES FROM THE CATALOGUE (the `Llms` namespace), so the text
 * is reviewed like any other copy and exists in both languages; the Bulgarian
 * file is /llms.txt, the English one /en/llms.txt, each linking to the other.
 * Nothing is invented here: the links are the footer's own, the licence is
 * the open-data constant, the trial length is the clubs constant.
 *
 * The clubs lines appear only while the add-on is on — a file that advertised
 * /klubove while it 404s would teach a model a dead link.
 */
import { CLUB_TRIAL_DAYS } from '@sportkarta/lib/clubs';
import { OPEN_DATA_API_VERSION, OPEN_DATA_LICENSE } from '@sportkarta/lib/opendata';
import { getTranslations } from 'next-intl/server';

import { siteUrl } from '@/lib/seo';
import { pageUrl } from '@/lib/structured-data';

export const LLMS_LOCALES = ['bg', 'en'] as const;
export type LlmsLocale = (typeof LLMS_LOCALES)[number];

/** Where each language's file lives: Bulgarian at the root, like every page. */
export function llmsPath(locale: LlmsLocale): string {
  return locale === 'en' ? '/en/llms.txt' : '/llms.txt';
}

function link(label: string, url: string, note?: string): string {
  return note ? `- [${label}](${url}): ${note}` : `- [${label}](${url})`;
}

export async function buildLlmsText(
  locale: LlmsLocale,
  options: { clubs: boolean },
): Promise<string> {
  const [t, tFooter, tSwitch] = await Promise.all([
    getTranslations({ locale, namespace: 'Llms' }),
    getTranslations({ locale, namespace: 'Footer' }),
    getTranslations({ locale, namespace: 'LocaleSwitcher' }),
  ]);
  const origin = siteUrl();
  const page = (path: string) => pageUrl(path, locale);
  const other: LlmsLocale = locale === 'en' ? 'bg' : 'en';

  const facts = [
    t('facts.free'),
    t('facts.license', { attribution: OPEN_DATA_LICENSE.attribution }),
    t('facts.languages'),
    ...(options.clubs ? [t('facts.clubs', { days: CLUB_TRIAL_DAYS })] : []),
  ];

  const pages = [
    link(tFooter('map'), page('/karta'), t('links.map')),
    link(t('labels.cities'), `${origin}/sitemaps/places.xml`, t('links.cities')),
    link(tFooter('sessions'), page('/igri'), t('links.games')),
    link(tFooter('stats'), page('/statistika'), t('links.stats')),
    ...(options.clubs
      ? [
          link(tFooter('clubsDirectory'), page('/klubove'), t('links.clubs')),
          link(tFooter('clubsLanding'), page('/za-klubove'), t('links.clubsLanding')),
        ]
      : []),
  ];

  const data = [
    link(tFooter('openData'), page('/danni'), t('links.data')),
    link(
      t('labels.api'),
      `${origin}/api/opendata/${OPEN_DATA_API_VERSION}/facilities`,
      t('links.dataApi'),
    ),
    link(tFooter('dataLicense'), page('/danni/litsenz'), t('links.license')),
  ];

  const about = [
    link(tFooter('privacy'), page('/privacy')),
    link(tFooter('terms'), page('/usloviya')),
    link(tFooter('contact'), page('/kontakt')),
    link(t('labels.sitemap'), `${origin}/sitemap.xml`, t('links.sitemap')),
    // The catalogue's own name for the OTHER language, as the switcher shows it.
    link(tSwitch('switchTo'), `${origin}${llmsPath(other)}`),
  ];

  const blocks = [
    `# ${t('title')}`,
    `> ${t('summary')}`,
    t('about'),
    facts.map((fact) => `- ${fact}`).join('\n'),
    `## ${t('sections.pages')}`,
    pages.join('\n'),
    `## ${t('sections.data')}`,
    data.join('\n'),
    `## ${t('sections.about')}`,
    about.join('\n'),
  ];
  return `${blocks.join('\n\n')}\n`;
}

/** The response both routes send: plain Markdown, an hour in any cache. */
export function llmsResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      // The file is ABOUT the site, not a page of it: keep it out of results.
      'X-Robots-Tag': 'noindex',
    },
  });
}
