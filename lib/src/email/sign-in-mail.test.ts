import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { POPS_MARK_PNG } from './assets/pops-mark.js';
import {
  POPS_MARK_CID,
  SIGN_IN_MAIL_STRING_KEYS,
  signInCodeEmail,
  type SignInMailStrings,
} from './sign-in-mail.js';

/**
 * The renderer's contract, against fixture strings. The real catalogues, the
 * 40 KB budget and the font's provenance are held by
 * apps/web/tests/sign-in-mail.test.ts, where the catalogues and
 * @fontsource/unbounded live.
 */

const STRINGS: SignInMailStrings = {
  subject: '{code} is your POPS sign-in code',
  preheader: 'Valid for {minutes} minutes.',
  eyebrow: 'SIGN IN TO POPS',
  title: 'Your sign-in code',
  lead: 'Enter it on <link>pops.bg</link> to sign in.',
  validity: 'Valid for {minutes} minutes',
  security: "Don't share it with anyone.",
  notYouTitle: "Didn't ask for a code?",
  notYouBody: 'Just delete this email.',
  motto: 'Find. Go. Play. Check in.',
  privacy: 'Privacy',
  terms: 'Terms',
  reason: 'You asked for a code on pops.bg.',
  tagline: 'More than just sport',
  textLead: 'Enter it on pops.bg to sign in. The code is valid for {minutes} minutes.',
};

function render(overrides: Partial<Parameters<typeof signInCodeEmail>[0]> = {}) {
  return signInCodeEmail({
    code: '482913',
    minutes: 30,
    strings: STRINGS,
    locale: 'en',
    ...overrides,
  });
}

/** Every URL the HTML points at, in attribute order. */
function urls(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((match) => match[1] ?? '');
}

/** The HTML without the data-URI font, whose base64 is not markup. */
function markup(html: string): string {
  return html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, 'data:font/woff2;base64,…');
}

describe('signInCodeEmail', () => {
  it('leads the subject with the code', () => {
    expect(render().subject).toBe('482913 is your POPS sign-in code');
  });

  it('gives the text part the code and the minutes, complete on its own', () => {
    const { text } = render();
    expect(text.split('\n')[0]).toBe('482913 is your POPS sign-in code.');
    expect(text).toContain('valid for 30 minutes');
    expect(text).toContain("Don't share it with anyone.");
    expect(text).toContain("Didn't ask for a code? Just delete this email.");
    expect(text.endsWith('POPS · More than just sport\nhttps://pops.bg/en\n')).toBe(true);
  });

  it('puts the code in the HTML exactly once, as one text node', () => {
    const { html } = render();
    expect(html.split('482913')).toHaveLength(2);
    // The whole code between two tags: nothing (no span, no &nbsp;) splits it,
    // so copy/paste and iOS code autofill read it whole.
    expect(html).toMatch(/>482913<\/div>/);
  });

  it('states the minutes in the preheader and under the code', () => {
    const { html } = render({ minutes: 30 });
    expect(html).toContain('Valid for 30 minutes.');
    expect(html).toContain('&nbsp;&nbsp;Valid for 30 minutes</div>');
  });

  it('turns <link> into the sign-in link and nothing else into markup', () => {
    const { html } = render();
    expect(html).toContain(
      'Enter it on <a href="https://pops.bg/en/vhod" style="color:#0B7A40;font-weight:600;text-decoration:none;">pops.bg</a> to sign in.',
    );
  });

  it('escapes everything it interpolates', () => {
    const hostile = '<img src=x onerror=alert(1)>"\'&';
    const strings = Object.fromEntries(
      SIGN_IN_MAIL_STRING_KEYS.map((key) => [key, `${STRINGS[key]} ${hostile}`]),
    ) as SignInMailStrings;
    const { html } = render({ strings, code: '<b>1</b>' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>1</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#x27;&amp;');
    expect(html).toContain('&lt;b&gt;1&lt;/b&gt;');
  });

  it('escapes the link text too, and leaves an unpaired <link> as text', () => {
    const { html } = render({
      strings: { ...STRINGS, lead: 'Go to <link>"pops"</link> or <link>nowhere.' },
    });
    expect(html).toContain('>&quot;pops&quot;</a>');
    expect(html).toContain('or &lt;link&gt;nowhere.');
  });

  it('keeps the subject to one line, whatever the catalogue says', () => {
    const { subject } = render({
      strings: { ...STRINGS, subject: '{code}\r\nBcc: x@example.org' },
    });
    expect(subject).toBe('482913 Bcc: x@example.org');
  });

  it('loads nothing remote and links only to pops.bg pages', () => {
    for (const locale of ['bg', 'en']) {
      const { html } = render({ locale });
      const base = locale === 'en' ? 'https://pops.bg/en' : 'https://pops.bg';
      expect(html).not.toContain('http://');
      // The only image is the inline mark; the only other URL kind is a link.
      expect(urls(html).filter((url) => !url.startsWith('https://pops.bg'))).toEqual([
        `cid:${POPS_MARK_CID}`,
      ]);
      expect(new Set(urls(html).filter((url) => url.startsWith('https:')))).toEqual(
        new Set([base, `${base}/vhod`, `${base}/privacy`, `${base}/usloviya`]),
      );
      // No CSS url() reaches out either: the only one is the data-URI font.
      expect([...markup(html).matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual([
        'data:font/woff2;base64,…',
      ]);
    }
  });

  it('speaks the member’s language: lang, font subset and link paths', () => {
    const bg = render({ locale: 'bg' }).html;
    const en = render({ locale: 'en' }).html;
    expect(bg).toContain('<html lang="bg"');
    expect(en).toContain('<html lang="en"');
    expect(bg).toContain('unicode-range:U+0301,U+0400-045F');
    expect(en).toContain('unicode-range:U+0000-00FF');
    expect(bg).toContain('href="https://pops.bg/vhod"');
    expect(en).toContain('href="https://pops.bg/en/vhod"');
    // Anything but English is the default locale, as on the site.
    expect(render({ locale: 'de' }).html).toBe(bg);
  });

  it('declares a light-only colour scheme and keeps the ink code panel', () => {
    const { html } = render();
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toMatch(/class="panel"[^>]*bgcolor="#101418"/);
  });

  it('sends the mark inline under the CID the HTML uses', () => {
    const { html, attachments } = render();
    expect(html).toContain(`src="cid:${POPS_MARK_CID}"`);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      filename: 'pops-mark.png',
      contentType: 'image/png',
      cid: POPS_MARK_CID,
    });
    // A real PNG, not an empty buffer.
    expect(
      Buffer.from(attachments[0]?.content ?? [])
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
  });

  it('is pure: the same input gives the same mail', () => {
    expect(render()).toEqual(render());
  });
});

describe('inline assets', () => {
  it('the mark module is pops-mark_240x200.png, byte for byte', () => {
    const png = readFileSync(
      fileURLToPath(new URL('./assets/pops-mark_240x200.png', import.meta.url)),
    );
    // Run apps/web/scripts/email-assets.mjs after replacing the PNG.
    expect(Buffer.from(POPS_MARK_PNG, 'base64').equals(png)).toBe(true);
  });
});
