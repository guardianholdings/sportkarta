interface UmamiAnalyticsProps {
  src: string;
  websiteId: string;
}

// Self-hosted, cookieless Umami. Rendered server-side only when both env vars
// are configured (see the [locale] layout). The script sets no cookies and
// collects no personally identifiable information.
//
// `data-exclude-search`: the tracker reports every history change, and the map
// writes its centre into the query string on each pan (`?lat=…&lng=…`, five
// decimals). After "locate me" that centre IS the visitor's position, so
// without this every pageview would carry it to the analytics database — while
// /privacy says the map's location never leaves the browser. Paths are enough:
// a facility, a city or a page is identified by its path.
export function UmamiAnalytics({ src, websiteId }: UmamiAnalyticsProps) {
  return <script defer src={src} data-website-id={websiteId} data-exclude-search="true" />;
}
