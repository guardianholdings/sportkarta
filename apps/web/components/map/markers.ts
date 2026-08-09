/**
 * DOM builders for the map's HTML markers — the POPS smile pin („Усмивката" as
 * a map pin, docs/design/pops-brand/HANDOFF.md) and the cluster bubble. Built
 * imperatively (not React) because MapLibre owns these elements; styling lives
 * in globals.css under `.sk-marker` / `.sk-cluster`.
 *
 * The pin's MOUTH carries the state and the colour only confirms it: a free
 * facility smiles in green (`--pin-free`), the selected one smiles in coral
 * (`--pin-active`, applied by the `.is-selected` class toggling `--pin-fill`).
 * The busy/straight-mouth state exists in the brand (public/brand/pin-busy.svg,
 * `--pin-busy`) but has no data source yet — the public facility payload
 * carries no occupancy — so it is deliberately not built here.
 *
 * The tip of the pin sits at the viewBox bottom-centre (50,96), matching the
 * MapLibre `anchor: 'bottom'` the explorer already uses.
 */

export interface PinOptions {
  slug: string;
  name: string;
}

/** The POPS smile pin. Returns the marker root element. */
export function createPin({ slug, name }: PinOptions): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sk-marker';
  el.dataset.slug = slug;
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', name);
  // MapLibre positions the marker by writing `transform` on the ROOT element, so
  // every transform of our own (the drop-in, the hover/select scale) must live on
  // inner wrappers — animating the root parks the pin at 0,0. `__drop` carries the
  // entrance animation, `__body` the interactive scale; they are separate elements
  // because an animation with `fill: both` would otherwise win over the scale.
  el.innerHTML = pinSvg();
  return el;
}

/** Shared pin markup — also used by the pin-picker and the facility mini-map. */
export function pinSvg(): string {
  return (
    '<span class="sk-marker__drop"><span class="sk-marker__body">' +
    '<svg class="sk-marker__pin" viewBox="0 0 100 100" aria-hidden="true">' +
    '<path class="sk-marker__pin-shape" d="M50 96 C50 96 16 60 16 38 A34 34 0 1 1 84 38 C84 60 50 96 50 96 Z"/>' +
    '<circle class="sk-marker__pin-face" cx="39" cy="30" r="5"/>' +
    '<circle class="sk-marker__pin-face" cx="61" cy="30" r="5"/>' +
    '<path class="sk-marker__pin-mouth" d="M32 42 A18 18 0 0 0 68 42"/>' +
    '</svg></span></span>'
  );
}

/**
 * A non-interactive pin for the pin-picker and the facility mini-map, in the
 * ACTIVE coral — both show „твоят спот": the place the page is about, or the
 * spot being placed. Decorative (the page names the place in text), so it is
 * hidden from the accessibility tree.
 */
export function createStaticPin(size = 36): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sk-marker sk-marker--active';
  el.style.width = `${String(size)}px`;
  el.style.height = `${String(size)}px`;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = pinSvg();
  return el;
}

/** The green cluster bubble showing a facility count in the mono face. */
export function createCluster(count: number): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sk-cluster';
  el.setAttribute('aria-hidden', 'true');
  const size = count >= 100 ? 46 : count >= 25 ? 40 : 34;
  el.style.width = `${String(size)}px`;
  el.style.height = `${String(size)}px`;
  el.textContent = count >= 1000 ? `${String(Math.round(count / 100) / 10)}k` : String(count);
  return el;
}
