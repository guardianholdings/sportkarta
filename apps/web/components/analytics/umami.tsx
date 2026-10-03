interface UmamiAnalyticsProps {
  src: string;
  websiteId: string;
}

/** The global the tracker calls before every send (its `data-before-send`). */
export const BEFORE_SEND_GLOBAL = 'popsUmamiBeforeSend';

/**
 * The campaign tags our published links carry (utm_*). They are the only part
 * of an address analytics ever receives, and only on a visit's landing
 * pageview — never the map's `?lat=…&lng=…`, never anything else.
 */
export const CAMPAIGN_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

/**
 * Runs inline, before the deferred tracker. It reads the campaign tags from the
 * address the visit LANDED on, and the tracker's before-send hook puts them back
 * on the first pageview only; every other pageview and every event goes out with
 * the query string removed, as `data-exclude-search` makes it. Without this the
 * launch links' utm_* never reach Umami and no visit can be tied to a post.
 *
 * Plain ES2017 in a string on purpose: this is exactly what ships, and
 * tests/umami-snippet.test.ts runs this very string.
 */
export const CAMPAIGN_HOOK_SCRIPT = `(function (w) {
  var keys = ${JSON.stringify(CAMPAIGN_PARAMS)};
  var landing = new URLSearchParams(w.location.search);
  var campaign = new URLSearchParams();
  for (var i = 0; i < keys.length; i++) {
    var value = landing.get(keys[i]);
    if (value) campaign.set(keys[i], value.slice(0, 200));
  }
  var query = campaign.toString();
  var pending = query !== '';
  w[${JSON.stringify(BEFORE_SEND_GLOBAL)}] = function (type, payload) {
    if (pending && type === 'event' && payload && !payload.name && typeof payload.url === 'string') {
      pending = false;
      try {
        var url = new URL(payload.url, w.location.href);
        url.search = query;
        payload.url = url.toString();
      } catch (e) {}
    }
    return payload;
  };
})(window);`;

// Self-hosted, cookieless Umami. Rendered server-side only when both env vars
// are configured (see the [locale] layout). The script sets no cookies and
// collects no personally identifiable information.
//
// `data-exclude-search`: the tracker reports every history change, and the map
// writes its centre into the query string on each pan (`?lat=…&lng=…`, five
// decimals). After "locate me" that centre IS the visitor's position, so
// without this every pageview would carry it to the analytics database — while
// /privacy says the map's location never leaves the browser. Paths are enough:
// a facility, a city or a page is identified by its path. The one exception is
// the campaign tags above, on the landing pageview (CAMPAIGN_HOOK_SCRIPT).
export function UmamiAnalytics({ src, websiteId }: UmamiAnalyticsProps) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: CAMPAIGN_HOOK_SCRIPT }} />
      <script
        defer
        src={src}
        data-website-id={websiteId}
        data-exclude-search="true"
        data-before-send={BEFORE_SEND_GLOBAL}
      />
    </>
  );
}
