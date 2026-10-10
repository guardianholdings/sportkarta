/**
 * Camera arithmetic for the map canvas, kept free of maplibre-gl so it can be
 * tested in plain Node — the canvas module imports WebGL code that cannot load
 * there.
 */

/** `[[west, south], [east, north]]`, the shape of `BULGARIA_BOUNDS`. */
export type Bounds = readonly [readonly [number, number], readonly [number, number]];

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Covered edges, in CSS px; an absent edge is uncovered (MapLibre's own shape). */
export interface FramePadding {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** Breathing room, in CSS px, between the country and the edge of the visible map. */
export const FIT_MARGIN_PX = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The Web-mercator zoom at which the box's longitude span fills `pixelWidth`
 * (less the margin on both sides): at zoom z the world is 512 · 2^z px wide
 * and spans 360°.
 */
export function widthFitZoom(pixelWidth: number, bounds: Bounds, margin = FIT_MARGIN_PX): number {
  const span = bounds[1][0] - bounds[0][0];
  return Math.log2(((pixelWidth - 2 * margin) * 360) / (512 * span));
}

/**
 * Web-mercator y of a latitude, as a fraction of the world's height: 0 at the
 * top edge, 1 at the bottom (MapLibre's convention, so y grows southwards).
 */
export function mercatorY(lat: number): number {
  const phi = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}

/** The inverse of `mercatorY`. */
export function latitudeAt(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** The part of the canvas the member can see, as the phone pan limit needs it. */
export interface VisibleFrame {
  /** The camera zoom (MapLibre's 512px world). */
  zoom: number;
  /** Half the visible height in CSS px: the canvas less the frame padding, halved. */
  halfHeight: number;
}

/**
 * The phone map's SOUTH LIMIT: the lowest latitude the camera centre may take
 * so that the bottom edge of the visible frame stays on `southLat` or north of
 * it.
 *
 * The basemap is a Bulgaria-only extract (scripts/build-tiles/build.sh, cut to
 * the same box as BULGARIA_BOUNDS), so there are no tiles south of the box's
 * southern edge: the archive stops at about 41°N (40.98°N, the tile-row edge
 * just under it). North of the country it reaches far further at the national
 * zooms, because whole tiles are kept and Bulgaria sits at the bottom of its
 * tile row (Romania is drawn up to 48.9°N at z5). A portrait phone showing the
 * country side to side has room to spare above AND below it; centred, the room
 * below fell off the tiles and showed the style's background — an empty beige
 * band between the country and the sheet (Boss, 2026-10-09). Keeping the
 * frame's bottom on the box's southern edge sends all of the spare room north,
 * where map exists. The box's edge rather than the exact tile edge: it is
 * covered at every zoom, whichever way the tile rows fall.
 */
export function southLimitLat(southLat: number, frame: VisibleFrame): number {
  const worldSize = 512 * 2 ** frame.zoom;
  return latitudeAt(mercatorY(southLat) - frame.halfHeight / worldSize);
}

/**
 * The map's pan limit: the camera CENTRE may not leave the box.
 *
 * The map cannot use MapLibre's `maxBounds`, because that constrains the
 * whole VIEWPORT: a portrait phone showing Bulgaria side to side spans about
 * four times the country's height, so a viewport-sized box would re-impose the
 * zoom floor the operator lifted (2026-08-07). With no box at all, two flicks
 * took the map to Mali — a blank beige field with no way back but reloading.
 *
 * Pinning the centre instead is the constraint that actually states the intent:
 * the middle of the visible map is always somewhere in Bulgaria, so the country
 * can never leave the screen, at any zoom, while the zoom floor stays free. The
 * centre MapLibre reports already accounts for the frame padding, so "the
 * middle" means the middle of the part above the sheet.
 *
 * Given the visible `frame`, the south limit (`southLimitLat`) applies on top,
 * and LAST, so it wins over the box's northern edge: when the frame is taller
 * than the room between the tile edge and the box's top (a phone with the sheet
 * collapsed), the centre goes north of the box rather than letting the frame's
 * bottom off the tiles. Desktop passes its frame too: `maxBounds` cropped the
 * country on any map area narrower than Bulgaria is wide (UX audit 2026-10-10).
 */
export function clampCenter(
  center: { lng: number; lat: number },
  bounds: Bounds,
  frame?: VisibleFrame,
): { lng: number; lat: number } {
  const lng = clamp(center.lng, bounds[0][0], bounds[1][0]);
  const lat = clamp(center.lat, bounds[0][1], bounds[1][1]);
  if (!frame) return { lng, lat };
  return { lng, lat: Math.max(lat, southLimitLat(bounds[0][1], frame)) };
}

/**
 * Whether a projected point sits inside the part of the canvas the member can
 * actually see — the canvas minus the frame padding (the sheet, the tab bar),
 * pulled in by `margin` so a pin whose tip is on screen but whose body is under
 * the sheet does not count as visible.
 */
export function insideVisibleFrame(
  point: ScreenPoint,
  size: { width: number; height: number },
  padding: FramePadding,
  margin: number,
): boolean {
  const { top = 0, right = 0, bottom = 0, left = 0 } = padding;
  return (
    point.x >= left + margin &&
    point.x <= size.width - right - margin &&
    point.y >= top + margin &&
    point.y <= size.height - bottom - margin
  );
}
