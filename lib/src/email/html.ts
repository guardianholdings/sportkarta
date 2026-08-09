/**
 * The one HTML wrapper every outgoing mail shares.
 *
 * Deliberately a WRAPPER, not a template language: the text part stays the
 * source of truth (it is what the tests assert on and what text-only clients
 * read), and this upgrades that exact content — escaped, linkified, paragraphed
 * — into a branded, table-free HTML part. No images, no webfonts, no tracking
 * pixels: email clients strip or block all three, and the product's rules
 * forbid the third anyway. The brand reaches the inbox as the coral top rule
 * and the palette, which survive every client.
 *
 * Colours are literal hex because an email resolves no CSS custom properties;
 * they mirror app/design-tokens/colors.css (paper, ink, muted, coral, green).
 */

const URL_RE = /https?:\/\/[^\s<>"']+/g;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Escape, then turn bare URLs into green links (the app's own link colour). */
function linkify(escapedLine: string): string {
  return escapedLine.replace(
    URL_RE,
    (url) => `<a href="${url}" style="color:#0B7A40">${url}</a>`,
  );
}

/**
 * Wrap a plain-text mail body in the brand shell. `text` is the exact string
 * the `text:` part carries; blank lines become paragraph breaks.
 */
export function brandEmailHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => linkify(escapeHtml(line)))
        .join('<br>'),
    )
    .filter((p) => p.length > 0)
    .map((p) => `<p style="margin:0 0 14px">${p}</p>`)
    .join('');

  return (
    '<!doctype html><html><body style="margin:0;padding:0;background:#F5F3EE">' +
    '<div style="max-width:560px;margin:0 auto;padding:16px">' +
    '<div style="height:4px;border-radius:2px;background:#FF4A2B"></div>' +
    '<div style="background:#FEFDFB;border:1px solid #E3DFD4;border-radius:14px;margin-top:12px;padding:20px;' +
    'color:#101418;font:15px/1.5 system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif">' +
    paragraphs +
    '</div></div></body></html>'
  );
}
