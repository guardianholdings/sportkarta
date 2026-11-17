import { serializeJsonLd } from '@/lib/json-ld';
import type { JsonLdNode } from '@/lib/structured-data';

/**
 * One structured-data block. A data block, not a script: the browser never
 * runs it, so it costs nothing at load and the script policy on a club's page
 * (lib/club-page-csp.ts) does not apply to it.
 *
 * The ONLY place that may write a `application/ld+json` element — the values
 * include facility and club names typed by strangers, and serializeJsonLd is
 * what stops one of them closing the element early (lib/json-ld.ts).
 */
export function JsonLd({ data }: { data: JsonLdNode }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
