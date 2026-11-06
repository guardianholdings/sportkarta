import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

import { skipUnderlayTile } from './underlay';

// The pmtiles Protocol is process-global; register it exactly once, shared by
// every MapLibre instance (main map + facility mini-maps). Imports maplibre,
// so this module is only ever pulled into client-only (ssr:false) chunks.
let registered = false;

export function ensurePmtilesProtocol(): void {
  if (registered) return;
  const protocol = new Protocol();
  // An underlay tile that the national archive draws over wherever it shows
  // (lib/map/underlay.ts, `nationalCovers`) is answered as an empty tile, the
  // way pmtiles answers a tile its archive lacks, without fetching its bytes.
  maplibregl.addProtocol('pmtiles', (params, abortController) =>
    skipUnderlayTile(params.url)
      ? Promise.resolve({ data: new Uint8Array() })
      : protocol.tilev4(params, abortController),
  );
  registered = true;
}
