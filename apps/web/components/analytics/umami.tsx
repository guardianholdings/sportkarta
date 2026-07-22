interface UmamiAnalyticsProps {
  src: string;
  websiteId: string;
}

// Self-hosted, cookieless Umami. Rendered server-side only when both env vars
// are configured (see the [locale] layout). The script sets no cookies and
// collects no personally identifiable information.
export function UmamiAnalytics({ src, websiteId }: UmamiAnalyticsProps) {
  return <script defer src={src} data-website-id={websiteId} />;
}
