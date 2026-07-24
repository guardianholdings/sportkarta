import { facilityFamily, FAMILY_COLOR, type SportFamily } from '@/lib/design/families';

/**
 * DOM builders for the map's HTML markers — the seed's signature teardrop
 * (category colour, white ring, white glyph) and the cluster bubble. Built
 * imperatively (not React) because MapLibre owns these elements; styling lives
 * in globals.css under `.sk-marker` / `.sk-cluster`, coloured per-marker via the
 * `--mk` custom property. Glyphs are family-level (10), matching the seed's
 * "colour + glyph = family, label = the specific sport".
 */

const GLYPH: Record<SportFamily, string> = {
  trail: '<path d="M3 20 9 8l4 7 2.5-4L21 20Z"/>',
  run: '<path d="M4 13h3l2-5 3 9 2-5h6"/>',
  wheels:
    '<circle cx="6.5" cy="16.5" r="3.1"/><circle cx="17.5" cy="16.5" r="3.1"/><path d="M6.5 16.5 10 9h5l2.6 7.5M9.5 9h4.5"/>',
  climb: '<path d="M12 4 20 19H4Z"/>',
  water:
    '<path d="M2 9c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2"/><path d="M2 15c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2"/>',
  team: '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6v16.8M6 6c3 3 3 9 0 12M18 6c-3 3-3 9 0 12"/>',
  body: '<path d="M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12"/>',
  racket: '<ellipse cx="9.5" cy="9" rx="5.5" ry="6.5"/><path d="M5.4 9h8.2M9.5 2.9v11.4M13 13 19 19"/>',
  precision: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.9"/>',
  multi:
    '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
};

function glyphSvg(family: SportFamily): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[family]}</svg>`;
}

export interface TeardropOptions {
  slug: string;
  name: string;
  sports: readonly string[];
}

/** A category-coloured teardrop pin. Returns the marker root element. */
export function createTeardrop({ slug, name, sports }: TeardropOptions): HTMLDivElement {
  const family = facilityFamily(sports);
  const el = document.createElement('div');
  el.className = 'sk-marker';
  el.dataset.slug = slug;
  el.style.setProperty('--mk', FAMILY_COLOR[family]);
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', name);
  // MapLibre positions the marker by writing `transform` on the ROOT element, so
  // every transform of our own (the drop-in, the hover/select scale) must live on
  // inner wrappers — animating the root parks the pin at 0,0. `__drop` carries the
  // entrance animation, `__body` the interactive scale; they are separate elements
  // because an animation with `fill: both` would otherwise win over the scale.
  el.innerHTML = `<span class="sk-marker__drop"><span class="sk-marker__body"><span class="sk-marker__pin"></span><span class="sk-marker__glyph">${glyphSvg(family)}</span></span></span>`;
  return el;
}

/** The pine cluster bubble showing a facility count in the mono face. */
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
