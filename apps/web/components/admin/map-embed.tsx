import { useTranslations } from 'next-intl';

// TODO(stage-2): replace the openstreetmap.org embed with the self-hosted
// MapLibre + pmtiles stack. Admin-only until then; ODbL attribution is both
// inside the embed and in the caption below (CLAUDE.md: attribution on every
// map view).
export function MapEmbed({ lon, lat, heightClass = 'h-56' }: MapEmbedProps) {
  const t = useTranslations('AdminMap');
  const d = 0.003;
  const bbox = `${String(lon - d)},${String(lat - d)},${String(lon + d)},${String(lat + d)}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${String(lat)}%2C${String(lon)}`;
  const link = `https://www.openstreetmap.org/?mlat=${String(lat)}&mlon=${String(lon)}#map=17/${String(lat)}/${String(lon)}`;

  return (
    <figure className="space-y-1">
      <iframe
        src={src}
        title={t('openInOsm')}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={`w-full ${heightClass} rounded border border-neutral-200`}
      />
      <figcaption className="text-xs text-neutral-500">
        <a href={link} target="_blank" rel="noreferrer" className="underline">
          {t('openInOsm')}
        </a>{' '}
        · {t('attribution')}
      </figcaption>
    </figure>
  );
}

interface MapEmbedProps {
  lon: number;
  lat: number;
  heightClass?: string;
}
