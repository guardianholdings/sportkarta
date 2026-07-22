/**
 * Serialize a JSON-LD object for safe embedding in an inline
 * `<script type="application/ld+json">`.
 *
 * `JSON.stringify` does NOT escape `<`, so a value containing `</script>`
 * (e.g. a hostile OSM facility name) would close the script element early and
 * inject arbitrary markup — stored XSS. Escape the HTML-significant characters
 * and the JS line terminators (U+2028/U+2029); the output still parses back to
 * the original value.
 */
// Built via fromCharCode so no literal line/paragraph separators appear in the
// source (they would break the file's own line handling).
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

const ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  [LINE_SEP]: '\\u2028',
  [PARA_SEP]: '\\u2029',
};

const UNSAFE = new RegExp(`[<>&${LINE_SEP}${PARA_SEP}]`, 'g');

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(UNSAFE, (ch) => ESCAPES[ch] ?? ch);
}
