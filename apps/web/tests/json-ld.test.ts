import { describe, expect, it } from 'vitest';

import { serializeJsonLd } from '../lib/json-ld';

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

// Facility names come from OSM (arbitrary user input) and are embedded in the
// facility page's <script type="application/ld+json">. Without escaping, a
// name containing </script> is stored XSS.
describe('serializeJsonLd', () => {
  it('neutralizes a </script> breakout in a value', () => {
    const hostile = 'x</script><img src=x onerror=alert(document.cookie)>';
    const out = serializeJsonLd({ name: hostile });
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<img');
    expect(out).toContain('\\u003c'); // '<' escaped
    // Still valid JSON that round-trips to the original value.
    expect((JSON.parse(out) as { name: string }).name).toBe(hostile);
  });

  it('escapes the JS line/paragraph separators', () => {
    const out = serializeJsonLd({ a: `${LINE_SEP}${PARA_SEP}` });
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    // No raw separators remain in the serialized output.
    expect(new RegExp(`[${LINE_SEP}${PARA_SEP}]`).test(out)).toBe(false);
  });

  it('escapes ampersands', () => {
    expect(serializeJsonLd({ a: 'x & y' })).toContain('\\u0026');
  });

  it('leaves ordinary (incl. Cyrillic) content parseable', () => {
    const out = serializeJsonLd({ '@type': 'SportsActivityLocation', name: 'Стадион „Обзор“' });
    const parsed = JSON.parse(out) as { '@type': string; name: string };
    expect(parsed['@type']).toBe('SportsActivityLocation');
    expect(parsed.name).toBe('Стадион „Обзор“');
  });
});
