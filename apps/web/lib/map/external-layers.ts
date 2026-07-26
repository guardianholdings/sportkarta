import 'server-only';

import type { ExternalMapLayer } from './layers';

/**
 * The external-layer catalogue, built per request on the server (the map page
 * is force-dynamic) so provider keys live in plain env vars — the
 * AUTH_GOOGLE_ENABLED pattern, not NEXT_PUBLIC build-time inlining. A layer
 * whose key is absent simply does not exist: no broken tiles, no switcher
 * entry, nothing to explain.
 *
 * CyclOSM needs no key (hosted by OpenStreetMap France; their tile policy
 * asks for correct attribution and moderate traffic, both honoured here).
 * Thunderforest and Tracestrack keys are publishable-by-design (they ride in
 * tile URLs) — restrict them by referrer/domain in the provider dashboards.
 */
export function externalMapLayers(): ExternalMapLayer[] {
  const layers: ExternalMapLayer[] = [
    {
      id: 'cyclosm',
      tiles: ['a', 'b', 'c'].map(
        (s) => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`,
      ),
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> · <a href="https://www.cyclosm.org" target="_blank" rel="noreferrer">CyclOSM</a> · <a href="https://www.openstreetmap.fr" target="_blank" rel="noreferrer">OSM France</a>',
      maxzoom: 20,
    },
  ];

  const thunderforest = process.env.THUNDERFOREST_API_KEY;
  if (thunderforest) {
    layers.push({
      id: 'transport',
      tiles: ['a', 'b', 'c'].map(
        (s) =>
          `https://${s}.tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=${thunderforest}`,
      ),
      attribution:
        'Maps © <a href="https://www.thunderforest.com" target="_blank" rel="noreferrer">Thunderforest</a> · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      maxzoom: 22,
    });
  }

  const tracestrack = process.env.TRACESTRACK_API_KEY;
  if (tracestrack) {
    layers.push({
      id: 'topo',
      tiles: [`https://tile.tracestrack.com/topo__/{z}/{x}/{y}.png?key=${tracestrack}`],
      attribution:
        '© <a href="https://www.tracestrack.com" target="_blank" rel="noreferrer">Tracestrack</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      maxzoom: 19,
    });
  }

  return layers;
}
