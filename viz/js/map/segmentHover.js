// Translate pointer events on the ways layers into hover/pin state updates.
// Plain click replaces the route with the clicked segment. Ctrl/Cmd+click
// toggles a segment in/out of the route, auto-orienting it against the
// previous tail. ESC and clicks on empty map space clear the route.

import {
  GRADIENTS_MAIN_LAYER_IDS,
  GRADIENTS_HOVER_LAYER_IDS,
  GRADIENTS_PIN_LAYER_IDS,
  GRADIENT_REGIONS,
  setSampleMarker,
  setActiveOsmIdForArrows,
} from './initMap.js';
import { samplePolyline } from '../elevation/lineSampling.js';
import {
  buildRouteFromSegments,
  orientAgainstTail,
} from '../elevation/routeBuilder.js';

const HOVER_DEBOUNCE_MS = 60;

export function setupSegmentHover({ map, appState, mapterhornClient }) {
  const canvas = map.getCanvas();
  let pendingTimer = null;
  let lastHoverFeatureKey = null;

  // ── Hover (preview when nothing pinned) ─────────────────────────────────
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

    // While pinned, hover only nudges the secondary highlight; don't burn a
    // Mapterhorn request on it.
    if (appState.getState().pinned) return;

    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      requestProfileForCurrentState({ appState, mapterhornClient, hovered });
    }, HOVER_DEBOUNCE_MS);
  });

  // ── Click: plain = replace, Ctrl/Cmd = toggle in route ──────────────────
  map.on('click', (event) => {
    const features = map.queryRenderedFeatures(event.point, {
      layers: GRADIENTS_MAIN_LAYER_IDS,
    });

    const original = event.originalEvent;
    const additive = !!(original && (original.ctrlKey || original.metaKey || original.shiftKey));

    if (features.length === 0) {
      // Plain click on empty map → unpin everything. Ctrl+click on empty
      // map → no-op (you didn't mean to drop your route by missing a way).
      if (!additive) appState.unpin();
      return;
    }

    const feature = pickClosestFeature(features);
    const osmId = readOsmId(feature);
    if (osmId === null) return;

    const regionId = regionIdForLayer(feature.layer?.id);
    const baseFeature = {
      osmId,
      regionId,
      properties: { ...feature.properties },
      coordinates: extractLineCoordinates(feature),
    };

    if (!additive) {
      // Plain click → replace the route with just this one segment.
      appState.pinFeature({ ...baseFeature, reversed: false });
    } else {
      // Ctrl+click → toggle in/out. If appending, auto-orient against the
      // previous tail of the current route so the route flows naturally.
      const { pinnedSegments } = appState.getState();
      const alreadyPinned = pinnedSegments.some((s) => s.osmId === osmId);

      if (alreadyPinned) {
        appState.togglePinnedFeature(baseFeature);
      } else {
        const prevTail = computePreviousTail(pinnedSegments);
        const { reversed } = orientAgainstTail(prevTail, baseFeature.coordinates);
        appState.togglePinnedFeature({ ...baseFeature, reversed });
      }
    }

    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    requestProfileForCurrentState({ appState, mapterhornClient });
  });

  // ── Keyboard: ESC unpins ────────────────────────────────────────────────
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && appState.getState().pinned) {
      appState.unpin();
    }
  });

  // ── Layer filter & marker sync (single writer) ──────────────────────────
  let appliedPinSignature = '';
  let appliedHoverKey = null;
  let appliedSampleKey = null;
  let appliedArrowOsmId = null;

  appState.subscribe((state) => {
    // Pin highlight: every pinned osm_id should light up in its region's
    // pin layer. We compute a per-region list of osm_ids and feed each
    // region's layer an `in` filter.
    const pinSignature = state.pinned
      ? state.pinnedSegments.map((s) => `${s.regionId}:${s.osmId}`).join('|')
      : '';
    if (pinSignature !== appliedPinSignature) {
      applyMultiRegionPinFilter(map, GRADIENTS_PIN_LAYER_IDS, state.pinnedSegments);
      appliedPinSignature = pinSignature;
    }

    // Hover highlight: shows the active feature when unpinned, or the
    // secondary indicator when pinned (and that indicator isn't already in
    // the pinned set).
    let hoverOsmId = null;
    let hoverRegion = null;
    if (state.pinned) {
      hoverOsmId = state.hoverIndicatorOsmId;
      hoverRegion = null; // we don't know region from osm_id alone — apply to all
    } else if (state.activeFeature) {
      hoverOsmId = state.activeFeature.osmId;
      hoverRegion = state.activeFeature.regionId ?? null;
    }
    const hoverKey = hoverOsmId === null ? '' : `${hoverRegion ?? '*'}:${hoverOsmId}`;
    if (hoverKey !== appliedHoverKey) {
      applyRegionScopedFilter(map, GRADIENTS_HOVER_LAYER_IDS, hoverRegion, hoverOsmId);
      appliedHoverKey = hoverKey;
    }

    // Sample marker mirroring the heightgraph cursor onto the map.
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

    // Direction arrows along the focused segment (only one set, even when
    // multiple are pinned — would be visually too noisy otherwise).
    const arrowOsmId = state.activeFeature?.osmId ?? null;
    if (arrowOsmId !== appliedArrowOsmId) {
      setActiveOsmIdForArrows(map, arrowOsmId);
      appliedArrowOsmId = arrowOsmId;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Profile request — route-aware
// ─────────────────────────────────────────────────────────────────────────

async function requestProfileForCurrentState({ appState, mapterhornClient, hovered }) {
  const state = appState.getState();

  if (state.pinned && state.pinnedSegments.length > 0) {
    return requestRouteProfile({ appState, mapterhornClient, segments: state.pinnedSegments });
  }
  if (hovered) {
    return requestSingleProfile({ appState, mapterhornClient, feature: hovered });
  }
}

// Sample the entire ordered route as one polyline. The heightgraph then
// shows a single continuous profile across all clicked segments, with
// segment boundaries marked on the X-axis.
async function requestRouteProfile({ appState, mapterhornClient, segments }) {
  const route = buildRouteFromSegments(segments);
  if (route.coordinates.length < 2) {
    appState.setProfileError(routeKey(segments), 'Keine Liniengeometrie zum Auswerten.');
    return;
  }

  const { samples, totalDistanceMeters } = samplePolyline(route.coordinates);
  if (samples.length < 2 || totalDistanceMeters <= 0) {
    appState.setProfileError(routeKey(segments), 'Keine Liniengeometrie zum Auswerten.');
    return;
  }

  const id = routeKey(segments);
  appState.setProfileLoading(id);

  try {
    const result = await mapterhornClient.sampleProfile(samples);
    const stats = computeStats(samples, result.elevations, totalDistanceMeters);
    appState.setProfileData(id, {
      samples,
      elevations: result.elevations,
      stats,
      // Segment-aware metadata for the heightgraph + chips:
      route: {
        joins: route.joins,
        segmentLengthsMeters: route.segmentLengthsMeters,
        cumulativeStartsMeters: route.cumulativeStartsMeters,
      },
    });
  } catch (error) {
    appState.setProfileError(id, error?.message || 'Höhenprofil konnte nicht geladen werden.');
  }
}

// Original single-segment path (used for hover preview when nothing is pinned).
async function requestSingleProfile({ appState, mapterhornClient, feature }) {
  const coordinates = feature.coordinates && feature.coordinates.length > 0
    ? feature.coordinates
    : [];
  const { samples, totalDistanceMeters } = samplePolyline(coordinates);

  if (samples.length < 2 || totalDistanceMeters <= 0) {
    appState.setProfileError(feature.osmId, 'Keine Liniengeometrie zum Auswerten.');
    return;
  }

  appState.setProfileLoading(feature.osmId);

  try {
    const result = await mapterhornClient.sampleProfile(samples);
    const stats = computeStats(samples, result.elevations, totalDistanceMeters);
    appState.setProfileData(feature.osmId, {
      samples,
      elevations: result.elevations,
      stats,
      properties: feature.properties,
    });
  } catch (error) {
    appState.setProfileError(feature.osmId, error?.message || 'Höhenprofil konnte nicht geladen werden.');
  }
}

// Stable id for a route, used to dedup setProfileData / setProfileError
// callbacks against the user pinning/removing segments mid-fetch.
function routeKey(segments) {
  return `route:${segments.map((s) => `${s.osmId}${s.reversed ? '-r' : ''}`).join(',')}`;
}

function computePreviousTail(pinnedSegments) {
  if (!pinnedSegments.length) return null;
  const last = pinnedSegments[pinnedSegments.length - 1];
  const coords = last.coordinates;
  if (!coords?.length) return null;
  return last.reversed ? coords[0] : coords[coords.length - 1];
}

// ─────────────────────────────────────────────────────────────────────────
// Map layer filter helpers
// ─────────────────────────────────────────────────────────────────────────

function applyMultiRegionPinFilter(map, layerIds, pinnedSegments) {
  // Group osm_ids by region — each region's pin layer only matches its own.
  const byRegion = new Map();
  for (const seg of pinnedSegments) {
    if (!byRegion.has(seg.regionId)) byRegion.set(seg.regionId, []);
    byRegion.get(seg.regionId).push(seg.osmId);
  }

  for (const layerId of layerIds) {
    if (!map.getLayer(layerId)) continue;
    const region = regionIdForLayer(layerId);
    const ids = byRegion.get(region) || [];
    if (ids.length === 0) {
      map.setFilter(layerId, ['==', ['get', 'osm_id'], -1]);
    } else if (ids.length === 1) {
      map.setFilter(layerId, ['==', ['get', 'osm_id'], ids[0]]);
    } else {
      map.setFilter(layerId, ['in', ['get', 'osm_id'], ['literal', ids]]);
    }
  }
}

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

function regionIdForLayer(layerId) {
  if (!layerId) return null;
  for (const region of GRADIENT_REGIONS) {
    const prefix = `gradients-${region.id}-`;
    if (layerId.startsWith(prefix)) return region.id;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Misc helpers (unchanged from single-pin version)
// ─────────────────────────────────────────────────────────────────────────

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
