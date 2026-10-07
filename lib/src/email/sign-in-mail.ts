/**
 * The sign-in code email (Boss, 7 Oct 2026: "make a beautiful mail template").
 *
 * A port of the CEO's reference generator, platform/email/2026-10-07_sign-in-code/
 * email_gen.py (v1). The markup, colours and sizes are the reference's; only the
 * three changes listed at the bottom differ, and no reader sees them.
 *
 * Pure, like the other mails here: the code, its lifetime in minutes and the
 * already-translated AuthEmail strings in, a message out. The strings come RAW
 * from apps/web/messages/<locale>.json; `{code}`, `{minutes}` and `<link>…</link>`
 * are filled here, and everything interpolated into the HTML is escaped.
 *
 * EMAIL-SAFE BY CONSTRUCTION
 *   - Tables and inline styles carry everything that matters. The <style> blocks
 *     are progressive enhancement only (brand font, phone sizes), so a client
 *     that drops them (Gmail strips @font-face, abv.bg may strip all <style>)
 *     still shows a finished mail.
 *   - One image, the coral mark, sent INLINE as a CID attachment: nothing is
 *     fetched when the mail is opened, so there is nothing to track and it shows
 *     even with remote images blocked. Its alt text is styled so the header
 *     still reads "POPS" when images are off.
 *   - The brand font is Unbounded 800 as a data-URI @font-face, one subset per
 *     locale (cyrillic for bg, latin for en). Apple Mail and iOS Mail use it;
 *     Gmail falls back to the system stack, which the design was checked in.
 *   - The code is ONE text node, so copy/paste and iOS code autofill read it
 *     whole. It also leads the subject: every mail gets its own subject, so
 *     Gmail never folds a new code under an old one, and a lock-screen
 *     notification shows it.
 *   - A light-only colour scheme is declared, and the colours survive forced
 *     dark-mode inversion (coral mark, ink code panel).
 *   - The whole HTML stays under 40 KB (the latin subset is the bulk of it);
 *     Gmail clips at 102 KB.
 *
 * CHANGES FROM THE REFERENCE (none visible)
 *   1. <title> carries the `title` string, not the subject, so the code occurs
 *      exactly once in the HTML.
 *   2. No `xmlns="http://www.w3.org/1999/xhtml"`: nothing needs it under
 *      <!doctype html>, and it was the only http:// in the file. Outlook's
 *      xmlns:v and xmlns:o stay.
 *   3. English mails link to /en/…: the site has localeDetection off, so /vhod
 *      always opens in Bulgarian.
 */

import { POPS_MARK_PNG } from './assets/pops-mark.js';
import { UNBOUNDED_800_WOFF2 } from './assets/unbounded-800.js';
import type { MailAttachment } from './mailer.js';

/** The AuthEmail message keys, in the order the reference lists them. */
export const SIGN_IN_MAIL_STRING_KEYS = [
  'subject',
  'preheader',
  'eyebrow',
  'title',
  'lead',
  'validity',
  'security',
  'notYouTitle',
  'notYouBody',
  'motto',
  'privacy',
  'terms',
  'reason',
  'tagline',
  'textLead',
] as const;

/**
 * AuthEmail, raw. Placeholders: `subject` has `{code}`; `preheader`, `validity`
 * and `textLead` have `{minutes}`; `lead` wraps the sign-in link in `<link>…</link>`.
 */
export type SignInMailStrings = Record<(typeof SIGN_IN_MAIL_STRING_KEYS)[number], string>;

export interface SignInCodeEmailInput {
  code: string;
  /** How long the code stays valid, in minutes. */
  minutes: number;
  strings: SignInMailStrings;
  /** The member's UI locale: `en`, or anything else for Bulgarian, the default locale. */
  locale: string;
}

export interface SignInCodeEmail {
  subject: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
}

/** The mark's Content-ID; the HTML points at it as `cid:pops-mark@pops.bg`. */
export const POPS_MARK_CID = 'pops-mark@pops.bg';

/**
 * Every link goes to the production site. The mail names pops.bg in its copy,
 * and the only mails sent from development go to an outbox nobody clicks in.
 */
const SITE = 'https://pops.bg';

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const DISPLAY = `'Unbounded',${SANS}`;
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Roboto Mono','Liberation Mono',monospace";
const LINK_STYLE = 'color:#0B7A40;font-weight:600;text-decoration:none;';

type FontSubset = keyof typeof UNBOUNDED_800_WOFF2;

/** Unicode ranges as fontsource publishes them for these subsets. */
const RANGES: Record<FontSubset, string> = {
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};

/** Hidden after the preheader so clients don't pad the inbox preview with body text. */
const PREHEADER_FILLER = '&#8199;&#65279;&#847; '.repeat(60);

const DOT =
  '<span style="color:#0FA958;font-size:10px;line-height:18px;vertical-align:1px;">&#9679;</span>';

/** Escape for HTML text and double-quoted attributes. */
function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

/** `{name}` → value, for the names given; anything else is left as written. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

function fontBlock(subset: FontSubset): string {
  return (
    "<style>@font-face{font-family:'Unbounded';font-style:normal;font-weight:800;" +
    `src:url(data:font/woff2;base64,${UNBOUNDED_800_WOFF2[subset]}) format('woff2');` +
    `unicode-range:${RANGES[subset]};}</style>`
  );
}

function renderHtml(
  code: string,
  minutes: number,
  s: SignInMailStrings,
  lang: 'bg' | 'en',
  base: string,
): string {
  // The template is escaped first and the escaped <link> pair then becomes the
  // anchor, so the link text is as escaped as everything else.
  const lead = esc(s.lead).replace(
    /&lt;link&gt;([\s\S]*?)&lt;\/link&gt;/g,
    (_, inner: string) => `<a href="${base}/vhod" style="${LINK_STYLE}">${inner}</a>`,
  );
  return `<!doctype html>
<html lang="${lang}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(s.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>table,td,p,a,h1,span,div{font-family:'Segoe UI',Arial,sans-serif !important;} .code{font-family:Consolas,'Courier New',monospace !important;}</style><![endif]-->
${fontBlock(lang === 'en' ? 'latin' : 'cyrillic')}
<style>
:root{color-scheme:light;supported-color-schemes:light;}
body{margin:0;padding:0;width:100% !important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
@media only screen and (max-width:600px){
.wrap{padding:28px 10px 36px !important;}
.card{padding:34px 20px 28px !important;border-radius:20px !important;}
.h1{font-size:24px !important;line-height:30px !important;}
.code{font-size:36px !important;letter-spacing:8px !important;padding-left:8px !important;}
.panel{padding:22px 8px 18px !important;}
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#F5F3EE;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#F5F3EE;">${esc(fill(s.preheader, { minutes }))}${PREHEADER_FILLER}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F5F3EE" style="background-color:#F5F3EE;">
<tr><td class="wrap" align="center" style="padding:44px 16px 52px;">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">

<tr><td align="center" style="padding:0 0 26px;">
<a href="${base}" style="text-decoration:none;"><img src="cid:${POPS_MARK_CID}" width="60" height="50" alt="POPS" style="display:block;width:60px;height:50px;border:0;outline:none;text-decoration:none;color:#FF4A2B;font-family:${SANS};font-size:22px;line-height:50px;font-weight:800;text-align:center;"></a>
</td></tr>

<tr><td class="card" bgcolor="#FEFDFB" align="center" style="background-color:#FEFDFB;border:1px solid #E3DFD4;border-radius:24px;padding:46px 40px 38px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding:0 0 14px;font-family:${MONO};font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.14em;color:#0B7A40;mso-line-height-rule:exactly;">${esc(s.eyebrow)}</td></tr>
<tr><td align="center" style="padding:0 0 12px;">
<h1 class="h1" style="margin:0;font-family:${DISPLAY};font-size:28px;line-height:34px;font-weight:800;letter-spacing:-0.02em;color:#101418;mso-line-height-rule:exactly;">${esc(s.title)}</h1>
</td></tr>
<tr><td align="center" style="padding:0 0 30px;font-family:${SANS};font-size:16px;line-height:24px;color:#313D49;mso-line-height-rule:exactly;">${lead}</td></tr>

<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:400px;">
<tr><td class="panel" align="center" bgcolor="#101418" style="background-color:#101418;border-radius:20px;padding:28px 16px 22px;">
<div class="code" style="font-family:${MONO};font-size:44px;line-height:50px;font-weight:700;letter-spacing:10px;padding-left:10px;color:#FFFFFF;white-space:nowrap;mso-line-height-rule:exactly;">${esc(code)}</div>
<div style="padding-top:12px;font-family:${SANS};font-size:13px;line-height:18px;font-weight:600;color:#C9CDD2;mso-line-height-rule:exactly;">${DOT}&nbsp;&nbsp;${esc(fill(s.validity, { minutes }))}</div>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:22px 8px 0;font-family:${SANS};font-size:14px;line-height:21px;color:#646A73;mso-line-height-rule:exactly;">${esc(s.security)}</td></tr>

<tr><td style="padding:30px 0 26px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #E3DFD4;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

<tr><td align="center" style="padding:0 0 4px;font-family:${SANS};font-size:15px;line-height:22px;font-weight:700;color:#101418;mso-line-height-rule:exactly;">${esc(s.notYouTitle)}</td></tr>
<tr><td align="center" style="padding:0 8px;font-family:${SANS};font-size:14px;line-height:21px;color:#646A73;mso-line-height-rule:exactly;">${esc(s.notYouBody)}</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:34px 16px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding:0 0 12px;font-family:${DISPLAY};font-size:14px;line-height:20px;font-weight:800;letter-spacing:-0.01em;color:#101418;mso-line-height-rule:exactly;">${esc(s.motto)}</td></tr>
<tr><td align="center" style="padding:0 0 14px;font-family:${SANS};font-size:13px;line-height:20px;color:#8A9099;mso-line-height-rule:exactly;"><a href="${base}" style="${LINK_STYLE}">pops.bg</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${base}/privacy" style="${LINK_STYLE}">${esc(s.privacy)}</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${base}/usloviya" style="${LINK_STYLE}">${esc(s.terms)}</a></td></tr>
<tr><td align="center" style="font-family:${SANS};font-size:12px;line-height:18px;color:#646A73;mso-line-height-rule:exactly;">${esc(s.reason)}</td></tr>
</table>
</td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;
}

/**
 * The text part: complete on its own, not a fallback. The code leads it, as it
 * leads the subject, so a text-only client and a notification preview both
 * show the code first.
 */
function renderText(code: string, minutes: number, s: SignInMailStrings, base: string): string {
  return (
    [
      `${fill(s.subject, { code })}.`,
      '',
      fill(s.textLead, { minutes }),
      '',
      s.security,
      '',
      `${s.notYouTitle} ${s.notYouBody}`,
      '',
      '--',
      `POPS · ${s.tagline}`,
      base,
    ].join('\n') + '\n'
  );
}

export function signInCodeEmail({
  code,
  minutes,
  strings,
  locale,
}: SignInCodeEmailInput): SignInCodeEmail {
  const lang = locale === 'en' ? 'en' : 'bg';
  const base = lang === 'en' ? `${SITE}/en` : SITE;
  return {
    // A header is one line: a stray line break in a catalogue edit must not
    // become header injection.
    subject: fill(strings.subject, { code }).replace(/[\r\n]+/g, ' '),
    text: renderText(code, minutes, strings, base),
    html: renderHtml(code, minutes, strings, lang, base),
    attachments: [
      {
        filename: 'pops-mark.png',
        contentType: 'image/png',
        cid: POPS_MARK_CID,
        content: Buffer.from(POPS_MARK_PNG, 'base64'),
      },
    ],
  };
}
