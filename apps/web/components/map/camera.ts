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
 * The phone map's pan limit: the camera CENTRE may not leave the box.
 *
 * The mobile map cannot use MapLibre's `maxBounds`, because that constrains the
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
 */
export function clampCenter(
  center: { lng: number; lat: number },
  bounds: Bounds,
): { lng: number; lat: number } {
  return {
    lng: clamp(center.lng, bounds[0][0], bounds[1][0]),
    lat: clamp(center.lat, bounds[0][1], bounds[1][1]),
  };
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
