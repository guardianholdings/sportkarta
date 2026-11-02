import { BULGARIA_BOUNDS } from '@sportkarta/lib/geo';

/**
 * The regional underlay: a low-zoom Protomaps extract of the countries around
 * Bulgaria (lon 14–37, lat 36–49, z0–7), served by the app itself from
 * `public/` and drawn UNDER the national basemap with the same layers and
 * paint (lib/map/style.ts).
 *
 * Why it exists (operator request 2026-11-02). The national archive keeps only the tiles
 * that touch the Bulgaria box, so beyond about 45.09° N and 40.98° N (and the
 * tile columns either side) only the style's flat background was drawn. A
 * desktop map area narrower than the box's shape (the list open on most
 * laptops) fits the country by its width, so the frame is taller than the box;
 * the camera then pushed the spare room north, onto that background — an empty
 * band over Romania. With the underlay there is real map on every side, and
 * the country can sit in the middle of the frame.
 *
 * Built by `scripts/build-tiles/build.sh region` from a pinned Protomaps
 * build; the date is in the file name, so the URL changes with the content and
 * the browser may keep it for a month (next.config.ts). Rebuilding means a new
 * file name here. See deploy/tiles/README.md.
 */
export const UNDERLAY_PATH = '/basemap/region-20261101.pmtiles';

/** The underlay's last zoom. MapLibre draws its z7 tiles, enlarged, above it. */
export const UNDERLAY_MAXZOOM = 7;

/**
 * The underlay's layers are drawn below this map zoom only. Above it MapLibre
 * fetches no underlay tile at all — a hidden layer's source is not used — so
 * zooming into a town never downloads the enlarged z7 tile under it. From
 * this zoom only the national archive is drawn, so the pan limit keeps the
 * bottom of the frame on the box's southern edge again (`keepsSouthLimit`).
 */
export const UNDERLAY_LAYER_MAXZOOM = 11;

/**
 * Whether the pan limit keeps the bottom of the visible frame on the box's
 * southern edge: `clampCenter` gets the frame, `openingCenter` its
 * `southLimit`.
 *
 * Without the underlay, always: the national archive's last tile row ends
 * just south of the box (40.98° N), and below it there is only the style's
 * background. With it, only from `UNDERLAY_LAYER_MAXZOOM`, where its layers
 * are hidden. Below that zoom the underlay draws south of the box, and the
 * fitted country stays centred in the frame. Dropping the limit at every zoom
 * let a centre dragged to the box's southern edge at zoom 11 leave an empty
 * band of about 360 px at the bottom of a 1512×870 window.
 */
export function keepsSouthLimit(underlay: boolean, zoom: number): boolean {
  return !underlay || zoom >= UNDERLAY_LAYER_MAXZOOM;
}

function tileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function tileY(lat: number, z: number): number {
  const phi = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
  return Math.floor(y * 2 ** z);
}

/**
 * The national archive's tiles at zoom `z`: every whole tile that touches the
 * box (scripts/build-tiles/build.sh extracts BULGARIA_BOUNDS' own numbers).
 * The ranges only shrink towards the box as the zoom grows.
 */
export function nationalRange(z: number) {
  const [[west, south], [east, north]] = BULGARIA_BOUNDS;
  return { x0: tileX(west, z), x1: tileX(east, z), y0: tileY(north, z), y1: tileY(south, z) };
}

/**
 * Whether the national archive draws over ALL of underlay tile z/x/y wherever
 * MapLibre shows it, so fetching it would only download bytes nobody sees.
 *
 * Below the underlay's last zoom, MapLibre shows tile z/x/y only at map zooms
 * z to z+1, where the national source draws its own tile z/x/y — present
 * exactly when it touches the box — and its opaque earth and water cover the
 * whole tile. The last zoom (z7) is also shown, enlarged, at every map zoom up
 * to `UNDERLAY_LAYER_MAXZOOM`, where the national tiles shrink towards the box;
 * so a z7 tile is covered only if every one of its tiles at the deepest of
 * those zooms is national. That holds for the two z7 tiles over southern
 * Bulgaria (Sofia, Plovdiv, Burgas): the box's southern edge, 41.0° N, lies
 * just north of the tile edge at 40.98° N.
 *
 * The answer must not depend on the map's zoom: MapLibre keeps a tile once it
 * has it, and shows it again at every zoom where it applies.
 */
export function nationalCovers(z: number, x: number, y: number): boolean {
  if (z < UNDERLAY_MAXZOOM) {
    const r = nationalRange(z);
    return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  }
  const deepest = UNDERLAY_LAYER_MAXZOOM - 1;
  const r = nationalRange(deepest);
  const k = 2 ** (deepest - z);
  return x * k >= r.x0 && (x + 1) * k - 1 <= r.x1 && y * k >= r.y0 && (y + 1) * k - 1 <= r.y1;
}

const PMTILES_TILE = /^pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/;

/**
 * Whether a `pmtiles://` tile request is an underlay tile the national archive
 * covers (see `nationalCovers`). TileJSON requests and every national tile
 * answer false, so they go to the archive as before.
 */
export function skipUnderlayTile(url: string): boolean {
  const match = PMTILES_TILE.exec(url);
  if (!match) return false;
  const [, archive = '', z, x, y] = match;
  if (!archive.endsWith(UNDERLAY_PATH)) return false;
  return nationalCovers(Number(z), Number(x), Number(y));
}
