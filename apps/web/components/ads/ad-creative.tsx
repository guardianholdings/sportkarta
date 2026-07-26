/**
 * The rendered form of one ad placement — MARKUP ONLY (docs/MONETISATION.md S5).
 *
 * Deliberately hook-free, fetch-free and prop-driven, because it is rendered
 * from BOTH trees: the server `<AdSlot>` on three surfaces, and the client-side
 * map explorer for the `map_panel` slot (whose data its server page fetched).
 * Nothing here may import `@/lib/ads` — that module reaches the database, and
 * dragging it into a client component would put the db client in the browser
 * bundle (apps/web/tests/client-imports.test.ts exists because that happens).
 *
 * The «Реклама» label is a required prop rather than optional decoration: a
 * paid placement must be labelled (ЗЗП / e-commerce rules), and there is no way
 * to call this component that renders the creative without it.
 */
export function AdCreative({
  id,
  url,
  alt,
  label,
}: {
  id: number;
  url: string;
  alt: string;
  label: string;
}) {
  return (
    <aside aria-label={label} className="space-y-1">
      <p className="text-caption uppercase tracking-wide text-text-faint">{label}</p>
      <a
        href={url}
        target="_blank"
        /* sponsored: a paid placement must not pass PageRank, and the collateral
           damage of getting that wrong would land on the /igrishta SEO pages
           these slots sit on. */
        rel="sponsored noopener"
        className="block overflow-hidden rounded-card border border-line bg-surface hover:opacity-95"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- row-decides
            route on our own origin; next/image would add a loader and a
            client-side dependency to the one component that must have neither */}
        <img
          src={`/api/ads/creative/${String(id)}`}
          alt={alt}
          className="h-auto w-full object-contain"
        />
      </a>
    </aside>
  );
}
