// Translate pointer events on the ways layers into hover/pin state updates.
// Hover triggers a debounced profile fetch; click pins a segment so the panel
// stays put while you mouse around. ESC and clicks on empty map space unpin.
//
// Multi-region: we listen to global mousemove/click on the map and use
// queryRenderedFeatures across all region main-layers in one call. The
// region a feature belongs to is encoded via the layer it came from; we
// stash that in the active feature so the hover/pin highlight stays scoped
// to the right region's source layer.

import {
  GRADIENTS_MAIN_LAYER_IDS,
  GRADIENTS_HOVER_LAYER_IDS,
  GRADIENTS_PIN_LAYER_IDS,
  GRADIENT_REGIONS,
  setSampleMarker,
  setActiveOsmIdForArrows,
} from './initMap.js';
import { samplePolyline } from '../elevation/lineSampling.js';

const HOVER_DEBOUNCE_MS = 60;

export function setupSegmentHover({ map, appState, mapterhornClient }) {
  const canvas = map.getCanvas();
  let pendingTimer = null;
  let lastHoverFeatureKey = null;

  // ── Pointer interactions ────────────────────────────────────────────────
  // One global mousemove handler — queryRenderedFeatures over all region
  // main-layers in a single call, which is what MapLibre does internally
  // anyway when you scope `map.on('mousemove', LAYER_ID, ...)`. Doing it
  // here lets us scale to N regions without N hover handlers.
  map.on('mousemove', (event) => {
    const features = map.queryRenderedFeatures(event.point, {
      layers: GRADIENTS_MAIN_LAYER_IDS,
    });

    if (features.length === 0) {
      if (canvas.style.cursor === 'pointer') canvas.style.cursor = '';
      if (lastHoverFeatureKey !== null) {
        lastHoverFeatureKey = null;
        if (pendingTimer !== null) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        appState.clearHover();
      }
      return;
    }

    canvas.style.cursor = 'pointer';

    const feature = pickClosestFeature(features);
    const osmId = readOsmId(feature);
    if (osmId === null) return;

    const regionId = regionIdForLayer(feature.layer?.id);
    // Dedup on osm_id + region — same osm_id should only show up in one
    // region, but be defensive about overlap on shared borders.
    const key = `${regionId}:${osmId}`;
    if (key === lastHoverFeatureKey) return;
    lastHoverFeatureKey = key;

    const hovered = {
      osmId,
      regionId,
      properties: { ...feature.properties },
      coordinates: extractLineCoordinates(feature),
    };

    appState.applyHover(hovered);

    // While pinned, applyHover only nudges the secondary highlight; don't
    // burn a Mapterhorn request on it.
    if (appState.getState().pinned) return;

    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      requestProfile({ appState, mapterhornClient, osmId, feature: hovered });
    }, HOVER_DEBOUNCE_MS);
  });

  // Click anywhere on the map. If a way is under the click point, pin it
  // (or toggle off if already pinned). Otherwise treat as "click empty" and
  // unpin.
  map.on('click', (event) => {
    const features = map.queryRenderedFeatures(event.point, {
      layers: GRADIENTS_MAIN_LAYER_IDS,
    });

    if (features.length === 0) {
      appState.unpin();
      return;
    }

    const feature = pickClosestFeature(features);
    const osmId = readOsmId(feature);
    if (osmId === null) {
      appState.unpin();
      return;
    }

    const regionId = regionIdForLayer(feature.layer?.id);
    const pinned = {
      osmId,
      regionId,
      properties: { ...feature.properties },
      coordinates: extractLineCoordinates(feature),
    };

    const wasPinnedSame = appState.getState().pinned
      && appState.getState().activeFeature?.osmId === osmId;

    appState.pinFeature(pinned);

    if (wasPinnedSame) return;

    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    requestProfile({ appState, mapterhornClient, osmId, feature: pinned });
  });

  // ── Keyboard: ESC unpins ────────────────────────────────────────────────
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && appState.getState().pinned) {
      appState.unpin();
    }
  });

  // ── Layer filter & marker sync (single writer) ──────────────────────────
  let appliedPinKey = null;
  let appliedHoverKey = null;
  let appliedSampleKey = null;
  let appliedArrowOsmId = null;
  appState.subscribe((state) => {
    // Pin highlight: only the active region's pin layer gets the osm_id —
    // every other region's pin layer goes back to filter == -1 (nothing).
    const pinOsmId = state.pinned ? state.activeFeature?.osmId ?? null : null;
    const pinRegion = state.pinned ? state.activeFeature?.regionId ?? null : null;
    const pinKey = pinOsmId === null ? '' : `${pinRegion}:${pinOsmId}`;
    if (pinKey !== appliedPinKey) {
      applyRegionScopedFilter(map, GRADIENTS_PIN_LAYER_IDS, pinRegion, pinOsmId);
      appliedPinKey = pinKey;
    }

    // Hover highlight: show the active feature when unpinned, OR the
    // secondary hover indicator when pinned. Suppress if it duplicates the
    // pinned osm_id.
    const hoverFeature = state.pinned
      ? { osmId: state.hoverIndicatorOsmId, regionId: null }
      : { osmId: state.activeFeature?.osmId ?? null, regionId: state.activeFeature?.regionId ?? null };
    const hoverOsmId = hoverFeature.osmId !== null && hoverFeature.osmId !== pinOsmId
      ? hoverFeature.osmId
      : null;
    // When pinned, we don't actually know which region the hovered way is
    // in (it's just an osm_id), so we apply the filter to ALL hover layers —
    // exactly one region will match (osm_ids are globally unique in OSM).
    const hoverRegion = hoverOsmId !== null ? hoverFeature.regionId : null;
    const hoverKey = hoverOsmId === null ? '' : `${hoverRegion ?? '*'}:${hoverOsmId}`;
    if (hoverKey !== appliedHoverKey) {
      applyRegionScopedFilter(map, GRADIENTS_HOVER_LAYER_IDS, hoverRegion, hoverOsmId);
      appliedHoverKey = hoverKey;
    }

    // Sample marker on the map mirroring the heightgraph hover.
    const sample = state.hoverSampleIndex !== null && state.profileData
      ? state.profileData.samples?.[state.hoverSampleIndex] ?? null
      : null;
    const sampleKey = sample
      ? `${state.profileSegmentId}:${state.hoverSampleIndex}`
      : null;
    if (sampleKey !== appliedSampleKey) {
      setSampleMarker(map, sample ? { lng: sample.lng, lat: sample.lat } : null);
      appliedSampleKey = sampleKey;
    }

    // Direction arrows along the active segment.
    const activeOsmId = state.activeFeature?.osmId ?? null;
    if (activeOsmId !== appliedArrowOsmId) {
      setActiveOsmIdForArrows(map, activeOsmId);
      appliedArrowOsmId = activeOsmId;
    }
  });
}

// Match a layer id like 'gradients-saarland-ways' back to its region id
// using the registered regions table. We can't just split on '-' because
// some region ids (baden_wuerttemberg) contain underscores not present in
// the prefix.
function regionIdForLayer(layerId) {
  if (!layerId) return null;
  for (const region of GRADIENT_REGIONS) {
    const prefix = `gradients-${region.id}-`;
    if (layerId.startsWith(prefix)) return region.id;
  }
  return null;
}

// Apply an osm_id filter to one region's layer while resetting all the
// others to the "match nothing" sentinel. Used for pin/hover highlights so
// only the relevant region's layer actually lights up. Passing
// targetRegionId=null means "no region active" → all layers reset.
//
// In the pinned-but-hovering-other case the caller passes targetRegionId=null
// for hover (we don't know the region from just an osm_id), in which case we
// apply the filter to ALL layers — exactly one will match because osm_ids
// are globally unique in OSM.
function applyRegionScopedFilter(map, layerIds, targetRegionId, osmId) {
  if (osmId === null || osmId === undefined) {
    const noMatch = ['==', ['get', 'osm_id'], -1];
    for (const layerId of layerIds) {
      if (map.getLayer(layerId)) map.setFilter(layerId, noMatch);
    }
    return;
  }

  const match = ['==', ['get', 'osm_id'], osmId];
  const noMatch = ['==', ['get', 'osm_id'], -1];
  for (const layerId of layerIds) {
    if (!map.getLayer(layerId)) continue;
    const inTargetRegion = targetRegionId === null
      || layerId.startsWith(`gradients-${targetRegionId}-`);
    map.setFilter(layerId, inTargetRegion ? match : noMatch);
  }
}

function pickClosestFeature(features) {
  for (const feature of features) {
    if (feature && feature.properties && feature.properties.osm_id !== undefined) {
      return feature;
    }
  }
  return features[0];
}

function readOsmId(feature) {
  if (!feature || !feature.properties) return null;
  const raw = feature.properties.osm_id;
  if (raw === undefined || raw === null) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function extractLineCoordinates(feature) {
  if (!feature || !feature.geometry) return [];
  const { type, coordinates } = feature.geometry;
  if (type === 'LineString') return coordinates;
  if (type === 'MultiLineString') {
    return coordinates.reduce((acc, part, index) => {
      if (index === 0) return part.slice();
      return acc.concat(part.slice(1));
    }, []);
  }
  return [];
}

async function requestProfile({ appState, mapterhornClient, osmId, feature }) {
  const coordinates = feature.coordinates && feature.coordinates.length > 0
    ? feature.coordinates
    : extractLineCoordinates(feature);
  const { samples, totalDistanceMeters } = samplePolyline(coordinates);

  if (samples.length < 2 || totalDistanceMeters <= 0) {
    appState.setProfileError(osmId, 'Keine Liniengeometrie zum Auswerten.');
    return;
  }

  appState.setProfileLoading(osmId);

  try {
    const result = await mapterhornClient.sampleProfile(samples);
    const stats = computeStats(samples, result.elevations, totalDistanceMeters);
    appState.setProfileData(osmId, {
      samples,
      elevations: result.elevations,
      stats,
      properties: feature.properties,
    });
  } catch (error) {
    appState.setProfileError(osmId, error?.message || 'Höhenprofil konnte nicht geladen werden.');
  }
}

function computeStats(samples, elevations, distanceMeters) {
  let ascent = 0;
  let descent = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < elevations.length; i += 1) {
    const value = elevations[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    if (i > 0 && Number.isFinite(elevations[i - 1])) {
      const dh = value - elevations[i - 1];
      if (dh > 0) ascent += dh;
      else descent -= dh;
    }
  }

  return {
    distanceMeters,
    ascentMeters: ascent,
    descentMeters: descent,
    minElevation: Number.isFinite(min) ? min : null,
    maxElevation: Number.isFinite(max) ? max : null,
  };
}
