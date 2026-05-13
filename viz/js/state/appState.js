// Single source of truth for the gradients viz. Subscribers re-render
// whenever a setter runs. Keeps the map, profile panel, and hover indicator
// in sync without ad-hoc cross-module wiring.

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
  // `activeFeature` / `profile*` describe what's shown in the panel — either
  // pulled in by hover (transient) or pinned by a click (sticky). `pinned`
  // flips the meaning: when true, hover stops updating activeFeature and
  // instead only feeds `hoverIndicatorOsmId` for a secondary map highlight.
  let state = {
    activeFeature: null,
    profileSegmentId: null,
    profileData: null,
    profileLoading: false,
    profileError: null,
    hoverSampleIndex: null,
    pinned: false,
    hoverIndicatorOsmId: null,
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

  return {
    getState: () => state,

    subscribe(subscriber) {
      subscribers.add(subscriber);
      subscriber(state);
      return () => subscribers.delete(subscriber);
    },

    // Hover-driven activation. While pinned, this only updates the secondary
    // highlight (different osm_id than the pinned one) and never displaces
    // the pinned panel content.
    applyHover(feature) {
      if (state.pinned) {
        const osmId = feature?.osmId ?? null;
        const indicator = osmId === state.activeFeature?.osmId ? null : osmId;
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
        profileSegmentId: null,
        profileData: null,
        profileLoading: false,
        profileError: null,
        hoverSampleIndex: null,
        hoverIndicatorOsmId: null,
      });
    },

    // Click-driven activation. Toggles off if you click the same segment again.
    pinFeature(feature) {
      if (!feature) return;
      const sameAsPinned = state.pinned && state.activeFeature?.osmId === feature.osmId;
      if (sameAsPinned) {
        update({
          pinned: false,
          activeFeature: null,
          profileSegmentId: null,
          profileData: null,
          profileLoading: false,
          profileError: null,
          hoverSampleIndex: null,
          hoverIndicatorOsmId: null,
        });
        return;
      }
      update({
        pinned: true,
        activeFeature: feature,
        hoverIndicatorOsmId: null,
        // Reset profile so the caller knows to (re-)fetch.
        profileSegmentId: null,
        profileData: null,
        profileLoading: false,
        profileError: null,
        hoverSampleIndex: null,
      });
    },

    unpin() {
      if (!state.pinned) return;
      update({
        pinned: false,
        activeFeature: null,
        profileSegmentId: null,
        profileData: null,
        profileLoading: false,
        profileError: null,
        hoverSampleIndex: null,
        hoverIndicatorOsmId: null,
      });
    },

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
      // Keep at least one step between thumbs so the user can always grab
      // either side; collapse-to-zero would render the slider unusable.
      const safeMin = Math.min(nextMin, nextMax);
      const safeMax = Math.max(nextMin, nextMax);
      if (safeMin === state.gradientFilterMin && safeMax === state.gradientFilterMax) return;
      update({ gradientFilterMin: safeMin, gradientFilterMax: safeMax });
    },
  };
}
