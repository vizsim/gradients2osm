import {
  createAppState,
  GRADIENT_FILTER_MIN,
  GRADIENT_FILTER_MAX,
} from './js/state/appState.js';
import {
  initMap,
  setMapGradientMetric,
  setMapGradientFilter,
  setMapBasemap,
  setMapRelief,
  setMapBuildings,
} from './js/map/initMap.js';
import { setupSegmentHover } from './js/map/segmentHover.js';
import { setupProfileView } from './js/profile/profileView.js';
import { createMapterhornClient } from './js/elevation/mapterhornClient.js';

// ── Resolve DOM references up-front so the subscribe-time render doesn't
// trip over temporal-dead-zone references. (We can't subscribe before
// these exist because subscribers fire immediately with the initial
// state.) ────────────────────────────────────────────────────────────────
const minThumb = document.getElementById('legend-thumb-min');
const maxThumb = document.getElementById('legend-thumb-max');
const dimLeft = document.getElementById('legend-dim-left');
const dimRight = document.getElementById('legend-dim-right');
const filterText = document.getElementById('legend-filter-text');
const filterReset = document.getElementById('legend-filter-reset');
const routingPanel = document.getElementById('routing-panel');
const routingPanelToggle = document.getElementById('routing-panel-toggle');
const mapSettingsPanel = document.getElementById('map-settings-panel');
const mapSettingsToggle = document.getElementById('map-settings-toggle');
const mapSettingsPanelToggle = document.getElementById('map-settings-panel-toggle');
const basemapButtons = Array.from(document.querySelectorAll('.basemap-btn[data-basemap]'));
const reliefToggle = document.getElementById('toggle-relief');
const buildingsToggle = document.getElementById('toggle-buildings');

const range = GRADIENT_FILTER_MAX - GRADIENT_FILTER_MIN;

const appState = createAppState();
const mapterhornClient = createMapterhornClient();

const mapApi = await initMap('map');

setupProfileView(appState);
setupSegmentHover({ map: mapApi.map, appState, mapterhornClient });

// ── Metric picker ───────────────────────────────────────────────────────
document.querySelectorAll('.metric-picker-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    appState.setGradientMetric(btn.dataset.metric);
  });
});

// ── Dual-range legend slider ────────────────────────────────────────────
const handleSliderInput = (which) => () => {
  const minVal = Number(minThumb.value);
  const maxVal = Number(maxThumb.value);
  // Prevent thumbs from crossing — nudge the other thumb out of the way so
  // a drag from either side feels equally direct.
  if (which === 'min' && minVal > maxVal) {
    maxThumb.value = String(minVal);
  } else if (which === 'max' && maxVal < minVal) {
    minThumb.value = String(maxVal);
  }
  appState.setGradientFilterRange({
    min: Number(minThumb.value),
    max: Number(maxThumb.value),
  });
};

minThumb.addEventListener('input', handleSliderInput('min'));
maxThumb.addEventListener('input', handleSliderInput('max'));

filterReset.addEventListener('click', () => {
  appState.setGradientFilterRange({
    min: GRADIENT_FILTER_MIN,
    max: GRADIENT_FILTER_MAX,
  });
});

routingPanelToggle.addEventListener('click', () => {
  const collapsed = routingPanel.classList.toggle('is-collapsed');
  routingPanelToggle.setAttribute('aria-expanded', String(!collapsed));
  routingPanelToggle.setAttribute('title', collapsed ? 'Panel erweitern' : 'Panel minimieren');
});

// ── Karte panel (basemap + relief + buildings) ──────────────────────────
// Panel starts collapsed (see `is-collapsed` in index.html) — the toggle
// button is the only thing visible until the user opens it.
const syncMapSettingsVisibility = () => {
  const collapsed = mapSettingsPanel.classList.contains('is-collapsed');
  mapSettingsToggle.setAttribute('aria-expanded', String(!collapsed));
  mapSettingsToggle.style.display = collapsed ? '' : 'none';
};
const toggleMapSettings = () => {
  mapSettingsPanel.classList.toggle('is-collapsed');
  syncMapSettingsVisibility();
};
mapSettingsToggle.addEventListener('click', toggleMapSettings);
mapSettingsPanelToggle.addEventListener('click', toggleMapSettings);
syncMapSettingsVisibility();

basemapButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    appState.setBasemap(btn.dataset.basemap);
  });
});

reliefToggle.addEventListener('change', (event) => {
  appState.setReliefEnabled(event.target.checked);
});

buildingsToggle.addEventListener('change', (event) => {
  appState.setBuildingsEnabled(event.target.checked);
});

// ── State → map sync ────────────────────────────────────────────────────
const initial = appState.getState();
setMapGradientMetric(mapApi.map, initial.gradientMetric);
applyMapFilter(initial);
setMapBasemap(mapApi.map, initial.basemap);
setMapRelief(mapApi.map, initial.reliefEnabled);
setMapBuildings(mapApi.map, initial.buildingsEnabled);
syncBasemapButtons(initial.basemap);
reliefToggle.checked = initial.reliefEnabled;
buildingsToggle.checked = initial.buildingsEnabled;

let lastMetric = initial.gradientMetric;
let lastMin = initial.gradientFilterMin;
let lastMax = initial.gradientFilterMax;
let lastBasemap = initial.basemap;
let lastRelief = initial.reliefEnabled;
let lastBuildings = initial.buildingsEnabled;

appState.subscribe((state) => {
  const metricChanged = state.gradientMetric !== lastMetric;
  const rangeChanged =
    state.gradientFilterMin !== lastMin
    || state.gradientFilterMax !== lastMax;

  if (metricChanged) {
    lastMetric = state.gradientMetric;
    setMapGradientMetric(mapApi.map, lastMetric);
  }
  if (metricChanged || rangeChanged) {
    lastMin = state.gradientFilterMin;
    lastMax = state.gradientFilterMax;
    applyMapFilter(state);
  }

  if (state.basemap !== lastBasemap) {
    lastBasemap = state.basemap;
    setMapBasemap(mapApi.map, lastBasemap);
    syncBasemapButtons(lastBasemap);
  }
  if (state.reliefEnabled !== lastRelief) {
    lastRelief = state.reliefEnabled;
    setMapRelief(mapApi.map, lastRelief);
    if (reliefToggle.checked !== lastRelief) reliefToggle.checked = lastRelief;
  }
  if (state.buildingsEnabled !== lastBuildings) {
    lastBuildings = state.buildingsEnabled;
    setMapBuildings(mapApi.map, lastBuildings);
    if (buildingsToggle.checked !== lastBuildings) buildingsToggle.checked = lastBuildings;
  }

  syncSliderUi(state);
});

function syncBasemapButtons(active) {
  basemapButtons.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.basemap === active);
  });
}

function applyMapFilter(state) {
  setMapGradientFilter(mapApi.map, {
    metric: state.gradientMetric,
    min: state.gradientFilterMin,
    max: state.gradientFilterMax,
    legendMax: GRADIENT_FILTER_MAX,
  });
}

function syncSliderUi(state) {
  const { gradientFilterMin: min, gradientFilterMax: max } = state;

  if (Number(minThumb.value) !== min) minThumb.value = String(min);
  if (Number(maxThumb.value) !== max) maxThumb.value = String(max);

  const leftPct = ((min - GRADIENT_FILTER_MIN) / range) * 100;
  const rightPct = 100 - ((max - GRADIENT_FILTER_MIN) / range) * 100;
  dimLeft.style.width = `${leftPct}%`;
  dimRight.style.width = `${rightPct}%`;

  const isDefault = min === GRADIENT_FILTER_MIN && max === GRADIENT_FILTER_MAX;
  if (isDefault) {
    filterText.textContent = 'alle Steigungen';
  } else {
    const lo = formatPercent(min);
    const hi = max >= GRADIENT_FILTER_MAX ? `${formatPercent(max)}+` : formatPercent(max);
    filterText.textContent = `nur ${lo} – ${hi}`;
  }
  filterReset.hidden = isDefault;
}

function formatPercent(value) {
  return Number.isInteger(value) ? `${value} %` : `${value.toFixed(1)} %`;
}
