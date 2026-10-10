'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

/**
 * MapLibre's own control strings, in the reader's language.
 *
 * Without them the library speaks English on the Bulgarian site: the canvas
 * announces itself as "Map", the compact attribution button as "Toggle
 * attribution", and the cooperative-gesture hint on the place maps reads "Use
 * ctrl + scroll to zoom the map" (UX audit 2026-10-10). The keys on the left
 * are MapLibre's; the text comes from `Map.controls` — `Map` is already in
 * every page's client messages (i18n/client-messages.ts).
 */
export function useMaplibreLocale(): Record<string, string> {
  const t = useTranslations('Map');
  return useMemo(
    () => ({
      'AttributionControl.ToggleAttribution': t('controls.toggleAttribution'),
      'AttributionControl.MapFeedback': t('controls.mapFeedback'),
      'Map.Title': t('controls.mapTitle'),
      'Marker.Title': t('controls.markerTitle'),
      'NavigationControl.ZoomIn': t('controls.zoomIn'),
      'NavigationControl.ZoomOut': t('controls.zoomOut'),
      'NavigationControl.ResetBearing': t('controls.resetBearing'),
      'GeolocateControl.FindMyLocation': t('controls.findMyLocation'),
      'GeolocateControl.LocationNotAvailable': t('controls.locationNotAvailable'),
      'Popup.Close': t('controls.close'),
      'CooperativeGesturesHandler.WindowsHelpText': t('controls.cooperativeWindows'),
      'CooperativeGesturesHandler.MacHelpText': t('controls.cooperativeMac'),
      'CooperativeGesturesHandler.MobileHelpText': t('controls.cooperativeMobile'),
    }),
    [t],
  );
}
