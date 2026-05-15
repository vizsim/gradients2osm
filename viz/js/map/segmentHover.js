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

// Half-side of the bbox we query for pointer events. Single-pixel point queries
// drop returns when terrain is enabled (MapLibre issue #6563: drape-rendered
// lines drift slightly from where queryRenderedFeatures looks), and a thin
// line at z<13 is only 1-2 px wide so even flat picking is finicky. An 8×8 px
// pick area makes hover/click robust under both modes.
const PICK_RADIUS_PX = 4;

function pickBoxAt(point) {
  return [
    [point.x - PICK_RADIUS_PX, point.y - PICK_RADIUS_PX],
    [point.x + PICK_RADIUS_PX, point.y + PICK_RADIUS_PX],
  ];
}

export function setupSegmentHover({ map, appState, mapterhornClient }) {
  const canvas = map.getCanvas();
  let pendingTimer = null;
  let lastHoverFeatureKey = null;

  // Hover is suspended while the map is moving (pan/zoom). queryRenderedFeatures
  // is expensive with terrain enabled, and burning it for every mousemove
  // during a pan piles up filter updates + profile requests for features the
  // user is just panning past anyway. We track the latest pointer position
  // even while suspended so we can re-evaluate hover once at the move end.
  let isMapMoving = false;
  let lastMousePoint = null;

  // requestAnimationFrame-coalesce the mousemove handler: a fast mouse fires
  // 60-120 events/s, each triggering a queryRenderedFeatures (terrain pick is
  // expensive). Coalescing to one work item per frame caps the cost at the
  // browser's actual paint rate, so under CPU pressure (heavy tile decode,
  // terrain drape) hover automatically slows down with the rest instead of
  // piling up a backlog of stale events.
  let rafScheduled = false;
  let pendingPoint = null;

  // Cancellation handle for the currently-awaiting profile request. When the
  // user hovers past one way faster than Mapterhorn responds, we abort the
  // previous request so its computeStats + state dispatch don't run on stale
  // data. The underlying tile fetches keep running and populate the LRU cache,
  // so the next hover that needs the same tiles still benefits.
  let activeProfileController = null;

  function startProfileRequest(args = {}) {
    if (activeProfileController) activeProfileController.abort();
    activeProfileController = new AbortController();
    return requestProfileForCurrentState({
      appState,
      mapterhornClient,
      signal: activeProfileController.signal,
      ...args,
    });
  }

  function processHoverAt(point) {
    const features = map.queryRenderedFeatures(pickBoxAt(point), {
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
      coordinates: getStitchedWayCoordinates(map, regionId, osmId, feature),
    };

    appState.applyHover(hovered);

    // While pinned, hover only nudges the secondary highlight; don't burn a
    // Mapterhorn request on it.
    if (appState.getState().pinned) return;

    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      startProfileRequest({ hovered });
    }, HOVER_DEBOUNCE_MS);
  }

  function scheduleHoverFlush() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (isMapMoving || pendingPoint === null) return;
      const point = pendingPoint;
      pendingPoint = null;
      processHoverAt(point);
    });
  }

  // ── Hover (preview when nothing pinned) ─────────────────────────────────
  map.on('mousemove', (event) => {
    lastMousePoint = event.point;
    if (isMapMoving) return;
    // Always overwrite pendingPoint so the rAF picks up the latest position;
    // older events on the queue are silently dropped — which is what we want.
    pendingPoint = event.point;
    scheduleHoverFlush();
  });

  // ── Suspend hover while the map is panning/zooming ─────────────────────
  map.on('movestart', () => {
    isMapMoving = true;
  });

  map.on('moveend', () => {
    isMapMoving = false;
    // Catch up once with the latest known pointer position so the user sees
    // an updated hover as soon as the map settles. If the mouse never entered
    // the canvas (lastMousePoint still null) there's nothing to do.
    if (lastMousePoint !== null) {
      pendingPoint = lastMousePoint;
      scheduleHoverFlush();
    }
  });

  // ── Click: plain = replace, Ctrl/Cmd = toggle in route ──────────────────
  map.on('click', (event) => {
    const features = map.queryRenderedFeatures(pickBoxAt(event.point), {
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
      coordinates: getStitchedWayCoordinates(map, regionId, osmId, feature),
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
    startProfileRequest();
  });

  // ── Keyboard: ESC unpins ────────────────────────────────────────────────
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && appState.getState().pinned) {
      appState.unpin();
    }
  });

  // ── Layer filter & marker sync (single writer) ──────────────────────────
  let appliedPinVersion = -1;
  let appliedHoverKey = null;
  let appliedSampleKey = null;
  let appliedArrowOsmId = null;

  appState.subscribe((state) => {
    // We track whether any line-layer filter actually changed this tick so
    // we can force a single repaint at the end (see comment near the bottom
    // of this callback for why that matters with terrain).
    let lineFiltersDirty = false;

    // Pin highlight: every pinned osm_id should light up in its region's
    // pin layer. We watch the monotonic pinnedSegmentsVersion (bumped by
    // appState on every mutation) instead of stringifying the array — the
    // heightgraph cursor fires this subscriber at 60 fps and the version
    // compare is a scalar instead of N string allocations + a join.
    if (state.pinnedSegmentsVersion !== appliedPinVersion) {
      applyMultiRegionPinFilter(map, GRADIENTS_PIN_LAYER_IDS, state.pinnedSegments);
      appliedPinVersion = state.pinnedSegmentsVersion;
      lineFiltersDirty = true;
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
      lineFiltersDirty = true;
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

    // With terrain enabled, MapLibre renders line layers into per-terrain-tile
    // "drape" framebuffers and reuses them as textures on the 3D mesh. A bare
    // setFilter on a draped line layer doesn't always invalidate that cache
    // immediately — the hover/pin lines then render with the *previous*
    // filter for one frame. Symbol layers (the arrows) billboard instead of
    // draping, so they're not affected. triggerRepaint forces the drape pass
    // to redraw with the new filter. Cheap (one render cycle), no-op without
    // terrain.
    if (lineFiltersDirty) {
      map.triggerRepaint();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Profile request — route-aware
// ─────────────────────────────────────────────────────────────────────────

async function requestProfileForCurrentState({ appState, mapterhornClient, hovered, signal }) {
  const state = appState.getState();

  if (state.pinned && state.pinnedSegments.length > 0) {
    return requestRouteProfile({ appState, mapterhornClient, segments: state.pinnedSegments, signal });
  }
  if (hovered) {
    return requestSingleProfile({ appState, mapterhornClient, feature: hovered, signal });
  }
}

// Sample the entire ordered route as one polyline. The heightgraph then
// shows a single continuous profile across all clicked segments, with
// segment boundaries marked on the X-axis.
async function requestRouteProfile({ appState, mapterhornClient, segments, signal }) {
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
    const result = await mapterhornClient.sampleProfile(samples, { signal });
    if (signal?.aborted) return;
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
    if (error?.name === 'AbortError') return;
    appState.setProfileError(id, error?.message || 'Höhenprofil konnte nicht geladen werden.');
  }
}

// Original single-segment path (used for hover preview when nothing is pinned).
async function requestSingleProfile({ appState, mapterhornClient, feature, signal }) {
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
    const result = await mapterhornClient.sampleProfile(samples, { signal });
    if (signal?.aborted) return;
    const stats = computeStats(samples, result.elevations, totalDistanceMeters);
    appState.setProfileData(feature.osmId, {
      samples,
      elevations: result.elevations,
      stats,
      properties: feature.properties,
    });
  } catch (error) {
    if (error?.name === 'AbortError') return;
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
      map.setFilter(layerId, ['==', ['to-number', ['get', 'osm_id']], -1]);
    } else if (ids.length === 1) {
      map.setFilter(layerId, ['==', ['to-number', ['get', 'osm_id']], ids[0]]);
    } else {
      map.setFilter(layerId, ['in', ['to-number', ['get', 'osm_id']], ['literal', ids]]);
    }
  }
}

function applyRegionScopedFilter(map, layerIds, targetRegionId, osmId) {
  if (osmId === null || osmId === undefined) {
    const noMatch = ['==', ['to-number', ['get', 'osm_id']], -1];
    for (const layerId of layerIds) {
      if (map.getLayer(layerId)) map.setFilter(layerId, noMatch);
    }
    return;
  }

  const match = ['==', ['to-number', ['get', 'osm_id']], osmId];
  const noMatch = ['==', ['to-number', ['get', 'osm_id']], -1];
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

// tippecanoe clips each way at tile boundaries, so a point-based
// queryRenderedFeatures only returns the fragment under the cursor — that's
// why Live "Länge" used to come out way shorter than the PMTiles length_m
// attribute. We use a viewport-wide queryRenderedFeatures on the main ways
// layer to fetch *all* fragments with the same osm_id at the current zoom,
// then stitch them by matching endpoints. Result is the full way's polyline
// (modulo tippecanoe quantization). Falls back to the single-feature path
// if the source isn't ready yet.
function getStitchedWayCoordinates(map, regionId, osmId, fallbackFeature) {
  const sourceId = `gradients-${regionId}`;
  if (!map.getSource(sourceId)) {
    return extractLineCoordinates(fallbackFeature);
  }

  // Use queryRenderedFeatures (not querySourceFeatures) to get *only*
  // features that the renderer is actually drawing at the current zoom. The
  // source cache holds tiles from many zoom levels (pre-fetched, retained
  // during zoom transitions); querySourceFeatures returns those too, so
  // the same OSM way shows up multiple times with different quantization
  // grids. The stitcher then joins z11 and z13 fragments via their
  // approximately-matching endpoints (within our 10 m tolerance), producing
  // zigzag traversals that double-count distance — which is exactly the
  // "Live 342 m on a 216 m way" symptom.
  //
  // queryRenderedFeatures with no geometry argument queries the whole
  // viewport on the named layer; the main-ways layer covers everything we
  // need. Filter by osm_id in JS for the same MLT/encoding robustness
  // reasons we kept from the previous approach.
  const mainLayerId = `gradients-${regionId}-ways`;
  let allFeatures;
  try {
    allFeatures = map.queryRenderedFeatures(undefined, { layers: [mainLayerId] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[stitch] queryRenderedFeatures threw', err);
    return extractLineCoordinates(fallbackFeature);
  }
  const osmIdStr = String(osmId);
  const osmIdNum = Number(osmId);
  const matchedAll = allFeatures.filter((f) => {
    const raw = f.properties?.osm_id;
    if (raw == null) return false;
    return raw === osmIdStr || raw === osmIdNum || Number(raw) === osmIdNum;
  });

  const features = matchedAll;

  // Expand each feature into one or more polylines (MultiLineString parts
  // are kept separate so the stitcher can reconnect them properly instead
  // of pretending they're already joined).
  const polylines = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'LineString' && g.coordinates.length >= 2) {
      polylines.push(g.coordinates);
    } else if (g.type === 'MultiLineString') {
      for (const part of g.coordinates) {
        if (part.length >= 2) polylines.push(part);
      }
    }
  }

  if (polylines.length === 0) return extractLineCoordinates(fallbackFeature);
  if (polylines.length === 1) return polylines[0];

  // The same fragment can appear twice in the source cache when the tile is
  // present at multiple zoom levels (during a zoom transition). Dedup by
  // hashing the whole polyline — only true duplicates collapse, two distinct
  // fragments that happen to share endpoints stay separate.
  const seen = new Set();
  const unique = [];
  for (const p of polylines) {
    const key = p.map((c) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  if (unique.length === 1) return unique[0];

  // Conservative endpoint-matching stitch. When fragments have aligned
  // endpoints (clean tile boundaries) we get the full polyline. When they
  // don't (overlapping fragments at zoom transitions, MapLibre keeping
  // multi-zoom tiles rendered, ...) we keep the longest fragment alone.
  // The remaining length gap is surfaced via a UI hint in profileView.js
  // — see the "Tile-Übergänge" caption on the Live section.
  return stitchPolylines(unique);
}

// Greedy endpoint-matching stitch. Picks the first polyline as the seed,
// then repeatedly finds a remaining polyline whose endpoint matches the
// chain's head or tail (in either orientation) and extends. Stops when no
// remaining polyline connects — returns the longest chain we could build.
// For ways where fragments overlap geographically (one zoom level's tile
// returns a coarse version of the way that overlaps the higher-zoom tile's
// fragment), the endpoints don't align and the stitcher keeps only the
// longest fragment. profileView.js detects this case via the live-vs-PMTiles
// length comparison and surfaces a tile-boundary hint to the user.
function stitchPolylines(polylines) {
  // ~10 m tolerance in degrees. tippecanoe should produce bit-exact endpoints
  // at tile boundaries, but in practice we see drift of a few meters between
  // adjacent tiles' clipped endpoints — bumping to 10 m is well below any
  // realistic OSM vertex spacing (residential ways are 10-50 m between nodes),
  // so we still can't accidentally fuse two unrelated fragments since they
  // all share the same osm_id by construction anyway.
  const TOL = 1e-4;
  const close = (a, b) =>
    Math.abs(a[0] - b[0]) < TOL && Math.abs(a[1] - b[1]) < TOL;

  const remaining = polylines.slice();
  let result = remaining.shift();
  let progress = true;

  while (progress && remaining.length > 0) {
    progress = false;
    const head = result[0];
    const tail = result[result.length - 1];

    for (let i = 0; i < remaining.length; i += 1) {
      const f = remaining[i];
      const fStart = f[0];
      const fEnd = f[f.length - 1];

      if (close(tail, fStart)) {
        result = result.concat(f.slice(1));
      } else if (close(tail, fEnd)) {
        result = result.concat(f.slice(0, -1).reverse());
      } else if (close(head, fStart)) {
        result = f.slice().reverse().concat(result.slice(1));
      } else if (close(head, fEnd)) {
        result = f.slice(0, -1).concat(result);
      } else {
        continue;
      }
      remaining.splice(i, 1);
      progress = true;
      break;
    }
  }

  return result;
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
