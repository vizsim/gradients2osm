// Single source of truth for the gradients viz. Subscribers re-render
// whenever a setter runs. Keeps the map, profile panel, and hover indicator
// in sync without ad-hoc cross-module wiring.
//
// Pinning model (v2 — multi-segment route):
//   - `pinnedSegments` is an ordered list of segments the user has Ctrl+clicked
//     into the current route. Each segment carries a `reversed` flag set by
//     the caller (segmentHover) when the geometry's natural direction has to
//     be flipped to chain with the previous segment's tail.
//   - `focusedPinnedIndex` is which segment in the list is highlighted in the
//     panel's "Details" view (PMTiles tags, slope distribution). Defaults to
//     the most recently appended one.
//   - `activeFeature` is a *derived* view-helper: it points at the focused
//     pinned segment when something is pinned, or at the latest hovered
//     segment when nothing is pinned. Pre-existing UI consumers keep
//     working without knowing about the multi-pin model.

const DEFAULT_GRADIENT_METRIC = 'gradient_smooth_pct';

export const GRADIENT_METRICS = [
  { id: 'gradient_smooth_pct', label: 'Geglättet', short: 'Geglättet', description: 'Steigung auf Savitzky-Golay-geglättetem Höhenprofil' },
  { id: 'gradient_abs_avg_pct', label: 'Mittel |abs|', short: 'Mittel', description: 'Längengewichteter |dh|/dl Mittelwert' },
  { id: 'gradient_endpoint_pct', label: 'Endpunkt', short: 'Endpunkt', description: '|h_last - h_first| / Länge' },
];

// Range covered by the legend slider in percent. The upper bound matches the
// "20 %+" label on the legend: when the max thumb sits at this value we
// remove the upper bound entirely so anything ≥ min is shown.
export const GRADIENT_FILTER_MIN = 0;
export const GRADIENT_FILTER_MAX = 20;
export const GRADIENT_FILTER_STEP = 0.5;

export const BASEMAPS = ['positron', 'osm', 'satellite'];
const DEFAULT_BASEMAP = 'positron';

export function createAppState() {
  let state = {
    pinnedSegments: [],
    focusedPinnedIndex: -1,
    // The "active" view binding. When pinnedSegments is empty, this carries
    // the hover preview. When non-empty, it's the focused pinned segment.
    activeFeature: null,
    pinned: false,
    hoverIndicatorOsmId: null,
    // Profile of the *current route* (= all pinned segments concatenated)
    // when pinned, OR of the hovered segment when not pinned.
    profileSegmentId: null,
    profileData: null,
    profileLoading: false,
    profileError: null,
    hoverSampleIndex: null,
    gradientMetric: DEFAULT_GRADIENT_METRIC,
    gradientFilterMin: GRADIENT_FILTER_MIN,
    gradientFilterMax: GRADIENT_FILTER_MAX,
    basemap: DEFAULT_BASEMAP,
    reliefEnabled: false,
    buildingsEnabled: false,
  };

  const subscribers = new Set();
  const notify = () => {
    subscribers.forEach((subscriber) => subscriber(state));
  };

  const update = (partial) => {
    state = { ...state, ...partial };
    notify();
  };

  // Reset profile-related fields together. Called whenever the route changes
  // composition (new pin, removed pin, switched focus is NOT included since
  // focus change doesn't change the underlying combined profile).
  const resetProfile = () => ({
    profileSegmentId: null,
    profileData: null,
    profileLoading: false,
    profileError: null,
    hoverSampleIndex: null,
  });

  const focusedFromList = (list, index) => {
    if (!list.length) return null;
    const safeIndex = Math.max(0, Math.min(index, list.length - 1));
    return list[safeIndex];
  };

  return {
    getState: () => state,

    subscribe(subscriber) {
      subscribers.add(subscriber);
      subscriber(state);
      return () => subscribers.delete(subscriber);
    },

    // ── Hover (transient preview) ─────────────────────────────────────────
    applyHover(feature) {
      if (state.pinned) {
        // While pinned, hover only feeds the secondary highlight on the map.
        // It does NOT change the panel, nor trigger Mapterhorn fetches.
        const osmId = feature?.osmId ?? null;
        const isAlreadyPinned = state.pinnedSegments.some((s) => s.osmId === osmId);
        const indicator = osmId === null || isAlreadyPinned ? null : osmId;
        if (state.hoverIndicatorOsmId !== indicator) {
          update({ hoverIndicatorOsmId: indicator });
        }
        return;
      }
      update({
        activeFeature: feature,
        hoverIndicatorOsmId: null,
      });
    },

    clearHover() {
      if (state.pinned) {
        if (state.hoverIndicatorOsmId !== null) {
          update({ hoverIndicatorOsmId: null });
        }
        return;
      }
      update({
        activeFeature: null,
        hoverIndicatorOsmId: null,
        ...resetProfile(),
      });
    },

    // ── Pin: replace the entire route with [feature] ──────────────────────
    pinFeature(feature) {
      if (!feature) return;
      // Click on the same segment that is currently the SOLE pin → toggle off.
      const isSoloAndSame = state.pinnedSegments.length === 1
        && state.pinnedSegments[0].osmId === feature.osmId;
      if (isSoloAndSame) {
        update({
          pinnedSegments: [],
          focusedPinnedIndex: -1,
          activeFeature: null,
          pinned: false,
          hoverIndicatorOsmId: null,
          ...resetProfile(),
        });
        return;
      }
      const next = { ...feature, reversed: false };
      update({
        pinnedSegments: [next],
        focusedPinnedIndex: 0,
        activeFeature: next,
        pinned: true,
        hoverIndicatorOsmId: null,
        ...resetProfile(),
      });
    },

    // ── Pin: toggle this segment in/out of the current route ─────────────
    // segmentHover passes the feature with a `reversed` flag pre-computed
    // from connectivity with the existing route's tail.
    togglePinnedFeature(feature) {
      if (!feature) return;
      const existingIndex = state.pinnedSegments.findIndex((s) => s.osmId === feature.osmId);

      if (existingIndex >= 0) {
        // Remove this segment from the route.
        const next = state.pinnedSegments.slice();
        next.splice(existingIndex, 1);

        if (next.length === 0) {
          update({
            pinnedSegments: [],
            focusedPinnedIndex: -1,
            activeFeature: null,
            pinned: false,
            hoverIndicatorOsmId: null,
            ...resetProfile(),
          });
          return;
        }

        // Keep focus on something reasonable: clamp to last index if the
        // removed one was at or beyond it.
        const newFocus = Math.min(state.focusedPinnedIndex, next.length - 1);
        update({
          pinnedSegments: next,
          focusedPinnedIndex: newFocus,
          activeFeature: focusedFromList(next, newFocus),
          pinned: true,
          hoverIndicatorOsmId: null,
          ...resetProfile(),
        });
        return;
      }

      // Append new segment to the route. `reversed` was decided by the caller
      // (segmentHover) based on connectivity to the previous tail.
      const augmented = { ...feature };
      const next = [...state.pinnedSegments, augmented];
      update({
        pinnedSegments: next,
        focusedPinnedIndex: next.length - 1,
        activeFeature: augmented,
        pinned: true,
        hoverIndicatorOsmId: null,
        ...resetProfile(),
      });
    },

    setFocusedPinnedIndex(index) {
      if (!state.pinned) return;
      if (index < 0 || index >= state.pinnedSegments.length) return;
      if (index === state.focusedPinnedIndex) return;
      update({
        focusedPinnedIndex: index,
        activeFeature: state.pinnedSegments[index],
      });
    },

    removePinnedAt(index) {
      if (!state.pinned) return;
      if (index < 0 || index >= state.pinnedSegments.length) return;
      const next = state.pinnedSegments.slice();
      next.splice(index, 1);
      if (next.length === 0) {
        update({
          pinnedSegments: [],
          focusedPinnedIndex: -1,
          activeFeature: null,
          pinned: false,
          hoverIndicatorOsmId: null,
          ...resetProfile(),
        });
        return;
      }
      const newFocus = Math.min(state.focusedPinnedIndex, next.length - 1);
      update({
        pinnedSegments: next,
        focusedPinnedIndex: newFocus,
        activeFeature: focusedFromList(next, newFocus),
        pinned: true,
        hoverIndicatorOsmId: null,
        ...resetProfile(),
      });
    },

    unpin() {
      if (!state.pinned) return;
      update({
        pinnedSegments: [],
        focusedPinnedIndex: -1,
        activeFeature: null,
        pinned: false,
        hoverIndicatorOsmId: null,
        ...resetProfile(),
      });
    },

    // ── Profile (Mapterhorn) state ────────────────────────────────────────
    setProfileLoading(segmentId) {
      update({
        profileSegmentId: segmentId,
        profileLoading: true,
        profileError: null,
      });
    },

    setProfileData(segmentId, data) {
      if (state.profileSegmentId !== segmentId) return;
      update({
        profileData: data,
        profileLoading: false,
        profileError: null,
        hoverSampleIndex: null,
      });
    },

    setProfileError(segmentId, error) {
      if (state.profileSegmentId !== segmentId) return;
      update({
        profileData: null,
        profileLoading: false,
        profileError: error,
        hoverSampleIndex: null,
      });
    },

    setHoverSampleIndex(index) {
      // Heightgraph mousemove can fire at the full display refresh rate;
      // bail early if nothing actually changed to skip the subscriber fan-out.
      if (state.hoverSampleIndex === index) return;
      update({ hoverSampleIndex: index });
    },

    // ── Map preferences ───────────────────────────────────────────────────
    setGradientMetric(metric) {
      if (!GRADIENT_METRICS.some((m) => m.id === metric)) return;
      if (state.gradientMetric === metric) return;
      update({ gradientMetric: metric });
    },

    setBasemap(basemap) {
      if (!BASEMAPS.includes(basemap)) return;
      if (state.basemap === basemap) return;
      update({ basemap });
    },

    setReliefEnabled(enabled) {
      const next = Boolean(enabled);
      if (state.reliefEnabled === next) return;
      update({ reliefEnabled: next });
    },

    setBuildingsEnabled(enabled) {
      const next = Boolean(enabled);
      if (state.buildingsEnabled === next) return;
      update({ buildingsEnabled: next });
    },

    setGradientFilterRange({ min, max }) {
      const clamp = (v, fallback) => {
        const num = Number(v);
        if (!Number.isFinite(num)) return fallback;
        if (num < GRADIENT_FILTER_MIN) return GRADIENT_FILTER_MIN;
        if (num > GRADIENT_FILTER_MAX) return GRADIENT_FILTER_MAX;
        return num;
      };
      const nextMin = clamp(min, state.gradientFilterMin);
      const nextMax = clamp(max, state.gradientFilterMax);
      const safeMin = Math.min(nextMin, nextMax);
      const safeMax = Math.max(nextMin, nextMax);
      if (safeMin === state.gradientFilterMin && safeMax === state.gradientFilterMax) return;
      update({ gradientFilterMin: safeMin, gradientFilterMax: safeMax });
    },
  };
}
