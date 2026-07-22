// Import from the pure ./sports subpath, not the barrel: the barrel re-exports
// the storage adapter (node:fs), which must never reach the browser bundle.
import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib/sports';

// Pure, client-safe filter model shared by the map UI (client) and the data
// layer (server). No DB imports here so it can ship in the browser bundle.

export const ACCESS_OPTIONS = ['free', 'paid', 'restricted', 'school'] as const;
export type AccessOption = (typeof ACCESS_OPTIONS)[number];

const SPORT_VALUES = new Set<string>(CANONICAL_SPORTS);
const SURFACE_VALUES = new Set<string>(CANONICAL_SURFACES);
const ACCESS_VALUES = new Set<string>(ACCESS_OPTIONS);

export interface PublicFilters {
  /** Canonical sport slugs; empty = any sport. */
  sports: string[];
  /** Access values; defaults to ['free'] (free-ON-by-default). */
  access: string[];
  /** Only floodlit facilities (lighting IS TRUE). */
  onlyLit: boolean;
  /** Canonical surface slugs; empty = any surface. */
  surfaces: string[];
}

function csv(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value.join(',') : value;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse + allowlist filters from URL search params. Unknown tokens are
 * dropped. Access defaults to `free`; an empty/all-invalid access selection
 * falls back to free so the map never silently shows nothing.
 */
export function parsePublicFilters(
  sp: Record<string, string | string[] | undefined>,
): PublicFilters {
  const sports = csv(sp.sport).filter((s) => SPORT_VALUES.has(s));
  const surfaces = csv(sp.surface).filter((s) => SURFACE_VALUES.has(s));
  const accessRaw =
    sp.access === undefined ? ['free'] : csv(sp.access).filter((a) => ACCESS_VALUES.has(a));
  const access = accessRaw.length > 0 ? accessRaw : ['free'];
  return { sports, access, onlyLit: sp.lighting === 'yes', surfaces };
}

/** True when access is exactly the default (free only). */
export function isDefaultAccess(access: string[]): boolean {
  return access.length === 1 && access[0] === 'free';
}

/** Serialize filters to URLSearchParams, omitting defaults (clean URLs). */
export function filtersToSearchParams(f: PublicFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.sports.length) params.set('sport', f.sports.join(','));
  if (f.surfaces.length) params.set('surface', f.surfaces.join(','));
  if (!isDefaultAccess(f.access)) params.set('access', f.access.join(','));
  if (f.onlyLit) params.set('lighting', 'yes');
  return params;
}
